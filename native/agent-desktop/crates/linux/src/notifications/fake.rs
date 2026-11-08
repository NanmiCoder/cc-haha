use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use agent_desktop_core::{
    AdapterError, Deadline, ErrorCode, InteractionLease, InteractionPolicy, MouseButton, Point,
    ProcessId, WindowInfo, WindowState,
};

use super::signal::{Held, Signal, SignalSource};
use super::world::ShellWorld;
use crate::system::shell::container::Landmark;
use crate::system::shell::light::Light;
use crate::system::shell::open::Opened;
use crate::system::shell::search::{Visit, Walk};
use crate::tree::vocabulary::role_numbers::{LABEL, NOTIFICATION, PUSH_BUTTON};
use crate::tree::{AtspiElement, Extents};

const PANEL: u32 = 39;

pub(crate) type Log = Rc<RefCell<Vec<String>>>;

pub(crate) fn log() -> Log {
    Rc::new(RefCell::new(Vec::new()))
}

pub(crate) fn lease(millis: u64) -> InteractionLease {
    InteractionLease::guarded(Deadline::after(millis).expect("a deadline"), ()).expect("a lease")
}

pub(crate) fn element(path: &str) -> AtspiElement {
    AtspiElement::new(":1.1", path, 1)
}

pub(crate) struct Spec {
    pub(crate) app: &'static str,
    pub(crate) title: &'static str,
    pub(crate) body: Option<&'static str>,
    pub(crate) time: Option<&'static str>,
    pub(crate) actions: Vec<&'static str>,
    pub(crate) expanded: bool,
    pub(crate) object: Option<&'static str>,
    pub(crate) buttons: usize,
}

pub(crate) fn spec(app: &'static str, title: &'static str) -> Spec {
    Spec {
        app,
        title,
        body: None,
        time: None,
        actions: Vec::new(),
        expanded: false,
        object: None,
        buttons: 2,
    }
}

impl Spec {
    pub(crate) fn body(mut self, body: &'static str) -> Self {
        self.body = Some(body);
        self
    }

    pub(crate) fn time(mut self, time: &'static str) -> Self {
        self.time = Some(time);
        self
    }

    pub(crate) fn actions(mut self, actions: &[&'static str]) -> Self {
        self.actions = actions.to_vec();
        self
    }

    pub(crate) fn expanded(mut self) -> Self {
        self.expanded = true;
        self
    }

    pub(crate) fn object(mut self, key: &'static str) -> Self {
        self.object = Some(key);
        self
    }

    pub(crate) fn header_buttons(mut self, count: usize) -> Self {
        self.buttons = count;
        self
    }
}

const LAID_OUT: Extents = Extents {
    x: 100,
    y: 100,
    width: 50,
    height: 20,
};
const HIDDEN: Extents = Extents {
    x: i32::MIN,
    y: i32::MIN,
    width: -1,
    height: -1,
};

fn add(
    visits: &mut Vec<Visit>,
    parent: Option<usize>,
    (role, name, path): (u32, &str, &str),
    extents: Extents,
) -> usize {
    let index = visits.len();
    visits.push(Visit {
        light: Light {
            element: element(path),
            role,
            name: name.to_owned(),
            extents: Some(extents),
            showing: true,
            visible: true,
            children: Vec::new(),
        },
        parent,
        children: Vec::new(),
    });
    if let Some(parent) = parent {
        visits[parent].children.push(index);
    }
    index
}

pub(crate) fn reading(specs: &[Spec]) -> Walk {
    let mut visits = Vec::new();
    let root = add(&mut visits, None, (PANEL, "", "/root"), LAID_OUT);
    let mut keys: Vec<String> = Vec::new();
    for entry in specs {
        let base = format!("{}:{}", entry.app, entry.title);
        let twins = keys.iter().filter(|key| **key == base).count();
        keys.push(base.clone());
        let key = match (entry.object, twins) {
            (Some(object), _) => object.to_owned(),
            (None, 0) => base,
            (None, _) => format!("{base}#{}", twins + 1),
        };
        let at = |suffix: &str| format!("/{key}{suffix}");
        let mut put = |parent: usize, role: u32, name: &str, suffix: &str, extents: Extents| {
            add(
                &mut visits,
                Some(parent),
                (role, name, &at(suffix)),
                extents,
            )
        };
        let notification = put(root, NOTIFICATION, "", "", LAID_OUT);
        let header = put(notification, PANEL, "", "/header", LAID_OUT);
        let texts = put(header, PANEL, "", "/header/texts", LAID_OUT);
        put(texts, LABEL, entry.app, "/app", LAID_OUT);
        if let Some(time) = entry.time {
            put(texts, LABEL, time, "/time", LAID_OUT);
        }
        if entry.buttons >= 2 {
            put(header, PUSH_BUTTON, "", "/expand", LAID_OUT);
        }
        if entry.buttons >= 1 {
            put(header, PUSH_BUTTON, "", "/close", LAID_OUT);
        }
        let content = put(notification, PANEL, "", "/content", LAID_OUT);
        put(content, LABEL, entry.title, "/title", LAID_OUT);
        if let Some(body) = entry.body {
            let boxed = put(content, PANEL, "", "/body_box", LAID_OUT);
            put(boxed, LABEL, body, "/body", LAID_OUT);
        }
        if !entry.actions.is_empty() {
            let row = put(notification, PANEL, "", "/actions", LAID_OUT);
            for action in &entry.actions {
                let extents = if entry.expanded { LAID_OUT } else { HIDDEN };
                let suffix = format!("/act/{action}");
                let button = put(row, PUSH_BUTTON, action, &suffix, extents);
                put(button, LABEL, action, &format!("{suffix}/label"), extents);
            }
        }
    }
    add(
        &mut visits,
        Some(root),
        (PUSH_BUTTON, "", "/clear"),
        LAID_OUT,
    );
    Walk {
        visits,
        complete: true,
    }
}

#[derive(Default)]
pub(crate) struct Faults {
    pub(crate) daemon: Option<DaemonFailure>,
    pub(crate) open: bool,
    pub(crate) window_info: bool,
    pub(crate) close_sticks: bool,
    pub(crate) click: bool,
    pub(crate) read_after_click: bool,
}

pub(crate) enum DaemonFailure {
    Absent,
    Unsupported,
}

#[derive(Default)]
struct Counts {
    clicks: Cell<usize>,
    reads: Cell<usize>,
}

pub(crate) struct FakeWorld {
    pub(crate) log: Log,
    stages: Vec<Walk>,
    counts: Counts,
    by_reads: bool,
    pub(crate) opened: Opened,
    pub(crate) showing: Cell<bool>,
    pub(crate) faults: Faults,
}

impl FakeWorld {
    pub(crate) fn new(log: &Log, stages: Vec<Walk>) -> Self {
        Self {
            log: Rc::clone(log),
            stages,
            counts: Counts::default(),
            by_reads: false,
            opened: Opened::Opened,
            showing: Cell::new(false),
            faults: Faults::default(),
        }
    }

    pub(crate) fn staged_by_reads(mut self) -> Self {
        self.by_reads = true;
        self
    }

    pub(crate) fn adopted(mut self) -> Self {
        self.opened = Opened::Adopted;
        self.showing.set(true);
        self
    }

    pub(crate) fn clicks(&self) -> Vec<String> {
        self.log
            .borrow()
            .iter()
            .filter_map(|line| line.strip_prefix("click:").map(str::to_owned))
            .collect()
    }

    fn note(&self, line: impl Into<String>) {
        self.log.borrow_mut().push(line.into());
    }
}

impl ShellWorld for FakeWorld {
    fn require_daemon(&self, _: Deadline) -> Result<(), AdapterError> {
        let daemon = match &self.faults.daemon {
            Some(DaemonFailure::Absent) => "absent",
            Some(DaemonFailure::Unsupported) => "unsupported",
            None => return Ok(()),
        };
        Err(AdapterError::new(
            ErrorCode::PlatformNotSupported,
            "The notification service cannot be used",
        )
        .with_details(serde_json::json!({ "daemon": daemon })))
    }

    fn locate(&self, landmark: Landmark, _: Deadline) -> Result<AtspiElement, AdapterError> {
        self.note(format!("locate:{landmark:?}"));
        Ok(element("/root"))
    }

    fn read(&self, _: &AtspiElement, _: Deadline) -> Result<Walk, AdapterError> {
        self.note("read");
        if self.faults.read_after_click && self.counts.clicks.get() > 0 {
            return Err(AdapterError::new(
                ErrorCode::Internal,
                "the shell tree could not be read",
            ));
        }
        let position = if self.by_reads {
            self.counts.reads.get()
        } else {
            self.counts.clicks.get()
        };
        self.counts.reads.set(self.counts.reads.get() + 1);
        let stage = position.min(self.stages.len() - 1);
        Ok(self.stages[stage].clone())
    }

    fn open(
        &self,
        _: InteractionPolicy,
        _: &InteractionLease,
    ) -> Result<(WindowInfo, Opened), AdapterError> {
        self.note("open");
        if self.faults.open || self.faults.window_info {
            let opened_by_call = self.opened == Opened::Opened;
            self.showing.set(true);
            let message = if self.faults.window_info {
                "window info could not be read"
            } else {
                "the list never showed"
            };
            return Err(AdapterError::timeout(message)
                .with_details(serde_json::json!({"surface_opened_by_call": opened_by_call})));
        }
        self.showing.set(true);
        let window = WindowInfo {
            id: "w".to_owned(),
            title: String::new(),
            app: String::new(),
            pid: ProcessId::new(1),
            process_instance: None,
            bounds: None,
            state: WindowState::default(),
        };
        Ok((window, self.opened))
    }

    fn close(&self, lease: &InteractionLease) -> Result<(), AdapterError> {
        self.note("close");
        if lease.deadline().is_expired() {
            return Err(AdapterError::timeout("the close ran on a spent deadline"));
        }
        if !self.faults.close_sticks {
            self.showing.set(false);
        }
        Ok(())
    }

    fn is_showing(&self, _: Deadline) -> Result<bool, AdapterError> {
        self.note("showing");
        Ok(self.showing.get())
    }

    fn click(
        &self,
        node: &AtspiElement,
        _: MouseButton,
        _: InteractionPolicy,
        _: &InteractionLease,
    ) -> Result<Point, AdapterError> {
        self.note(format!("click:{}", node.path()));
        if self.faults.click {
            return Err(AdapterError::new(
                ErrorCode::ActionFailed,
                "the click failed",
            ));
        }
        self.counts.clicks.set(self.counts.clicks.get() + 1);
        Ok(Point { x: 0.0, y: 0.0 })
    }
}

pub(crate) struct FakeSignals {
    pub(crate) log: Log,
    pub(crate) signals: Vec<Signal>,
    pub(crate) fails: bool,
}

struct Heard(Vec<Signal>);

impl Held for Heard {
    fn collect(self: Box<Self>, _: Duration) -> Vec<Signal> {
        self.0
    }
}

impl SignalSource for FakeSignals {
    fn subscribe(&self, _: Deadline) -> Result<Box<dyn Held>, AdapterError> {
        self.log.borrow_mut().push("subscribe".to_owned());
        if self.fails {
            return Err(AdapterError::new(ErrorCode::Internal, "no session bus"));
        }
        Ok(Box::new(Heard(self.signals.clone())))
    }
}
