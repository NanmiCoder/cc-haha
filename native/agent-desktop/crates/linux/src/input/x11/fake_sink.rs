use std::collections::VecDeque;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use crate::input::delivery::Delivery;
use agent_desktop_core::{AdapterError, Deadline};

use super::pointer_read::PointerRead;

use super::sink_error::SinkError;

use super::sink::X11Sink;
use crate::input::keyboard::keymap::Keymap;
use crate::input::keyboard::keymap_edit::KeymapEdit;
use crate::input::plan::Plan;
use crate::input::step::Step;

type EventBarrier = (Sender<()>, Receiver<()>);

fn update_edge(held: &mut Vec<u8>, code: u8, down: bool) {
    held.retain(|held| *held != code);
    if down {
        held.push(code);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Recorded {
    Key(u8, bool),
    Button(u8, bool),
    Move(i16, i16),
    Keymap(KeymapEdit),
    RoundTrip,
}

pub(crate) struct FakeWorld {
    pub(crate) queries: Vec<&'static str>,
    pub(crate) events: Vec<Recorded>,
    pub(crate) keymap: Keymap,
    pub(crate) fail_on_event: Option<usize>,
    pub(crate) panic_on_event: Option<usize>,
    pub(crate) root: (u16, u16),
    pub(crate) sticky_buttons: Vec<u8>,
    pub(crate) sticky_keys: Vec<u8>,
    pub(crate) move_stall: Duration,
    pub(crate) fail_verification: bool,
    sent: usize,
    held_keys: Vec<u8>,
    key_reads: VecDeque<[u8; 32]>,
    pointer_reads: VecDeque<PointerRead>,
    held_buttons: Vec<u8>,
    at: (i16, i16),
}

#[derive(Clone)]
pub(crate) struct FakeSink {
    world: Arc<Mutex<FakeWorld>>,
    before_event: Arc<Mutex<Option<EventBarrier>>>,
}

pub(crate) fn start_keymap() -> Keymap {
    Keymap::new(
        8,
        2,
        vec![0x61, 0x41, 0x62, 0x42, 0, 0, 0, 0, 0, 0, 0, 0],
        1,
        vec![50],
    )
}

impl FakeSink {
    pub(crate) fn new() -> Self {
        Self {
            world: Arc::new(Mutex::new(FakeWorld {
                queries: Vec::new(),
                events: Vec::new(),
                keymap: start_keymap(),
                fail_on_event: None,
                panic_on_event: None,
                root: (1280, 800),
                sticky_buttons: Vec::new(),
                sticky_keys: Vec::new(),
                move_stall: Duration::ZERO,
                fail_verification: false,
                sent: 0,
                held_keys: Vec::new(),
                key_reads: VecDeque::new(),
                pointer_reads: VecDeque::new(),
                held_buttons: Vec::new(),
                at: (0, 0),
            })),
            before_event: Arc::default(),
        }
    }

    pub(crate) fn world(&self) -> MutexGuard<'_, FakeWorld> {
        self.world
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn recorded(&self) -> Vec<Recorded> {
        self.world().events.clone()
    }

    pub(crate) fn failing_on(self, event: usize) -> Self {
        self.world().fail_on_event = Some(event);
        self
    }

    pub(crate) fn panicking_on(self, event: usize) -> Self {
        self.world().panic_on_event = Some(event);
        self
    }

    pub(crate) fn scripted_key_reads(&self, reads: Vec<[u8; 32]>) {
        self.world().key_reads = reads.into();
    }

    pub(crate) fn scripted_pointer_reads(&self, reads: Vec<PointerRead>) {
        self.world().pointer_reads = reads.into();
    }

    pub(crate) fn block_next_event(&self) -> (Receiver<()>, Sender<()>) {
        let (started, ready) = channel();
        let (resume, wait) = channel();
        *self.before_event.lock().unwrap() = Some((started, wait));
        (ready, resume)
    }

    fn admit(&self, recorded: Recorded) -> Result<(), SinkError> {
        let barrier = self.before_event.lock().unwrap().take();
        if let Some((started, resume)) = barrier {
            started.send(()).unwrap();
            resume.recv().unwrap();
        }
        let mut world = self.world();
        world.sent += 1;
        if world.panic_on_event == Some(world.sent) {
            drop(world);
            panic!("injected panic");
        }
        if world.fail_on_event == Some(world.sent) {
            return Err(SinkError::Request("injected failure".into()));
        }
        world.events.push(recorded);
        Ok(())
    }
}

impl X11Sink for FakeSink {
    fn key(&mut self, code: u8, down: bool) -> Result<(), SinkError> {
        self.admit(Recorded::Key(code, down))?;
        let mut world = self.world();
        update_edge(&mut world.held_keys, code, down);
        Ok(())
    }

    fn button(&mut self, code: u8, down: bool) -> Result<(), SinkError> {
        self.admit(Recorded::Button(code, down))?;
        let mut world = self.world();
        update_edge(&mut world.held_buttons, code, down);
        Ok(())
    }

    fn move_to(&mut self, x: i16, y: i16) -> Result<(), SinkError> {
        let stall = self.world().move_stall;
        thread::sleep(stall);
        self.admit(Recorded::Move(x, y))?;
        self.world().at = (x, y);
        Ok(())
    }

    fn round_trip(&mut self) -> Result<(), SinkError> {
        self.world().events.push(Recorded::RoundTrip);
        Ok(())
    }

    fn pointer(&mut self) -> Result<PointerRead, SinkError> {
        let mut world = self.world();
        if world.fail_verification {
            return Err(SinkError::Closed);
        }
        if let Some(read) = world.pointer_reads.pop_front() {
            return Ok(read);
        }
        let mut mask = 0u16;
        for code in world.held_buttons.iter().chain(world.sticky_buttons.iter()) {
            mask |= 0x80 << code;
        }
        Ok(PointerRead {
            x: i32::from(world.at.0),
            y: i32::from(world.at.1),
            mask,
        })
    }

    fn keys_down(&mut self) -> Result<[u8; 32], SinkError> {
        let mut world = self.world();
        if world.fail_verification {
            return Err(SinkError::Closed);
        }
        if let Some(read) = world.key_reads.pop_front() {
            return Ok(read);
        }
        let mut bits = [0u8; 32];
        for code in world.held_keys.iter().chain(world.sticky_keys.iter()) {
            bits[usize::from(*code / 8)] |= 1 << (code % 8);
        }
        Ok(bits)
    }

    fn keymap(&mut self) -> Result<Keymap, SinkError> {
        self.world().queries.push("keymap");
        Ok(self.world().keymap.clone())
    }

    fn ensure_text_state(&mut self) -> Result<(), AdapterError> {
        let mut world = self.world();
        world.queries.push("text_state");
        world.keymap.ensure_text_state()
    }

    fn edit_keymap(&mut self, edit: &KeymapEdit) -> Result<(), SinkError> {
        self.admit(Recorded::Keymap(edit.clone()))?;
        let mut world = self.world();
        let width = usize::from(world.keymap.keysyms_per_keycode);
        let start = usize::from(edit.keycode - world.keymap.min_keycode) * width;
        world.keymap.keysyms[start..start + width].copy_from_slice(&edit.keysyms);
        Ok(())
    }

    fn root_size(&mut self) -> Result<(u16, u16), SinkError> {
        self.world().queries.push("root_size");
        Ok(self.world().root)
    }
}

pub(crate) fn deadline(ms: u64) -> Deadline {
    Deadline::detached_after(ms).expect("deadline")
}

pub(crate) fn drag_plan() -> Plan {
    Plan {
        steps: vec![
            Step::MoveTo { x: 10, y: 10 },
            Step::Button {
                code: 1,
                down: true,
            },
            Step::MoveTo { x: 20, y: 20 },
            Step::MoveTo { x: 30, y: 30 },
            Step::Button {
                code: 1,
                down: false,
            },
        ],
        release_origin: Some((10, 10)),
    }
}

pub(crate) fn run(
    fake: &FakeSink,
    plans: Vec<Plan>,
    gate: crate::input::delivery::Gate<'_>,
    deadline: Deadline,
    slot: Option<Arc<super::worker_slot::WorkerSlot>>,
) -> Result<Delivery, AdapterError> {
    let fake = fake.clone();
    super::session::run_journaled(
        move || Ok(fake),
        plans,
        gate,
        super::session::CallEnv {
            deadline,
            journal: None,
            slot: slot.unwrap_or_default(),
            release_on_signal: false,
            lease: None,
        },
    )
}

pub(crate) fn events(fake: &FakeSink) -> Vec<Recorded> {
    fake.recorded()
        .into_iter()
        .filter(|event| *event != Recorded::RoundTrip)
        .collect()
}
