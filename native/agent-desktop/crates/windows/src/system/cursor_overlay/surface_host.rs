//! The renderer's state: where the cursor is, what style it wears, and what
//! it does when a control arrives.
//!
//! Core owns the trajectory. `CursorMotion` is a function of elapsed
//! milliseconds, so this samples a clock rather than counting frames — a
//! dropped frame changes smoothness and never the instant the cursor lands,
//! which is the instant the action is waiting on.
//!
//! A control is served in two halves. `apply` does only what has to be true
//! before its sender is answered: the style and the caption are adopted, and
//! a travel puts the cursor at its destination. `settle` plays what nothing
//! waits on — the card easing in, the click flourish — after the answer has
//! gone out and the connection has been released, so the next control is
//! already being read while the last one is still finishing on screen.

#[cfg(target_os = "windows")]
use super::presentation::{Presentation, RestState};
#[cfg(target_os = "windows")]
use crate::system::cursor_overlay::{
    animation, caret_mark::CaretMark, fade, label, monitors, render, reveal::Reveal, schedule,
    session_state, text, topology::DisplayTopology, window::OverlayWindow,
};
#[cfg(target_os = "windows")]
use agent_desktop_core::{
    AdapterError, CURSOR_HIGHLIGHT_HOLD_MS, CURSOR_IDLE_REST_MS, CURSOR_REST_FADE_MS, CursorMotion,
    CursorOverlayControl, CursorPhase, LABEL_FONT_POINTS, Point, Rect,
};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

/// Thirteen hops, matching the reference, which is enough that the fade
/// reads as continuous without costing a frame per pixel row.
#[cfg(target_os = "windows")]
const REST_FADE_STEPS: u32 = 13;

#[cfg(target_os = "windows")]
pub(crate) struct SurfaceHost {
    window: OverlayWindow,
    caret: CaretMark,
    session_id: String,
    presentation: Presentation,
    rest: RestState,
    idle_rest_delay: Duration,
    watch: session_state::EndWatch,
    topology: DisplayTopology,
}

#[cfg(target_os = "windows")]
impl SurfaceHost {
    pub(crate) fn create(session_id: String) -> Result<Self, AdapterError> {
        let topology = DisplayTopology::probe();
        let pose = monitors::resting_point(topology.monitors()).unwrap_or(Point { x: 0.0, y: 0.0 });
        Ok(Self {
            window: OverlayWindow::create()?,
            caret: CaretMark::create()?,
            session_id,
            presentation: Presentation::resting_at(pose),
            rest: RestState {
                resting: false,
                quiet_since: Instant::now(),
            },
            idle_rest_delay: schedule::idle_rest_delay(
                std::env::var("AGENT_DESKTOP_CURSOR_IDLE_MS")
                    .ok()
                    .as_deref(),
            ),
            watch: session_state::EndWatch::default(),
            topology,
        })
    }

    pub(crate) fn idle_tick(&self) -> Duration {
        Duration::from_millis(CURSOR_IDLE_REST_MS / 4)
    }

    /// Everything that must be true before the control's sender is
    /// answered, and nothing else. A travel is here because the action
    /// dispatches the moment its acknowledgement arrives, so the cursor
    /// has to already be where the click will land.
    pub(crate) fn apply(&mut self, control: &CursorOverlayControl) -> Result<(), AdapterError> {
        if self.rest.resting && control.is_caret_follow() {
            return Ok(());
        }
        self.rest.resting = false;
        self.rest.quiet_since = Instant::now();
        if let Some(style) = control.style() {
            self.presentation.style = style.clone();
        }
        self.adopt_label(control);
        match control {
            CursorOverlayControl::Enable { .. } | CursorOverlayControl::Show { .. } => {
                self.begin_reveal();
                self.draw(0.0, None, 0.0)?;
            }
            CursorOverlayControl::Hide { .. } | CursorOverlayControl::Disable { .. } => {
                self.clear();
                self.rest.resting = true;
            }
            CursorOverlayControl::Present { instruction, .. } => match instruction.phase() {
                CursorPhase::Travel => {
                    self.presentation.depart(instruction.is_pointer());
                    self.travel(
                        instruction.destination().clone(),
                        instruction.target().cloned(),
                    )?;
                }
                CursorPhase::Drag => self.take_drag_origin(
                    instruction
                        .drag_from()
                        .unwrap_or_else(|| instruction.destination())
                        .clone(),
                    instruction.target().cloned(),
                )?,
                phase @ (CursorPhase::Caret | CursorPhase::CaretFollow) => {
                    let accent = self.presentation.style.accent_rgb();
                    let follow = phase == CursorPhase::CaretFollow;
                    self.caret.place(instruction.target(), accent, follow);
                }
                CursorPhase::Effect => {}
            },
        }
        Ok(())
    }

    /// Everything nothing waits on, played after the sender has been
    /// answered and the connection released.
    ///
    /// `interrupt` reports that a newer control is already on the wire.
    /// Honouring it keeps a flourish from spending its hold on an action
    /// that has already been superseded, and keeps the sender of that
    /// newer control from spending its arrival budget on a busy pipe.
    pub(crate) fn settle(&mut self, control: &CursorOverlayControl, interrupt: &dyn Fn() -> bool) {
        match control {
            CursorOverlayControl::Enable { .. } | CursorOverlayControl::Show { .. } => {
                self.play_reveal(None, interrupt);
            }
            CursorOverlayControl::Present { instruction, .. } => {
                let target = instruction.target().cloned();
                match instruction.phase() {
                    CursorPhase::Travel | CursorPhase::Drag => {
                        self.play_reveal(target.as_ref(), interrupt);
                    }
                    CursorPhase::Effect => self.effect(
                        instruction.destination().clone(),
                        target,
                        instruction.is_click(),
                        interrupt,
                    ),
                    CursorPhase::Caret | CursorPhase::CaretFollow => {}
                }
            }
            CursorOverlayControl::Hide { .. } | CursorOverlayControl::Disable { .. } => {}
        }
    }

    /// Marks the drag origin before dispatching the physical pointer action.
    fn take_drag_origin(
        &mut self,
        origin: Point,
        target: Option<Rect>,
    ) -> Result<(), AdapterError> {
        self.presentation.depart(false);
        self.travel(origin, target)
    }

    /// Plays the motion core computed, then leaves the cursor at its
    /// destination. Deliberately unstoppable: this is the one loop an
    /// action is blocked on, so giving it up for a newer control would
    /// dispatch a click at wherever the cursor had got to.
    fn travel(&mut self, destination: Point, target: Option<Rect>) -> Result<(), AdapterError> {
        self.caret
            .hide_when_leaving(&self.presentation.pose, &destination);
        let motion = CursorMotion::new(self.presentation.pose.clone(), destination.clone())
            .with_impact(false)
            .with_ripple(false);
        let frames = animation::Frames::at(self.topology.refresh_hz());
        loop {
            let elapsed = frames.elapsed_ms();
            if schedule::has_arrived(elapsed, motion.duration_ms()) {
                break;
            }
            self.presentation.pose = motion.pose(elapsed).point;
            // Intermediate frames may be dropped. Only the destination
            // frame determines whether this travel can be acknowledged.
            let _ = self.draw(0.0, target.as_ref(), 0.0);
            frames.wait();
        }
        self.presentation.pose = destination;
        self.presentation.arrive();
        self.draw(0.0, target.as_ref(), 0.0)?;
        self.begin_reveal();
        Ok(())
    }

    /// The click flourish and the outline, after dispatch has already
    /// confirmed. Fire-and-forget by contract, so nothing waits on it and
    /// anything newer takes it over.
    fn effect(
        &mut self,
        destination: Point,
        target: Option<Rect>,
        click: bool,
        interrupt: &dyn Fn() -> bool,
    ) {
        self.presentation.pose = destination.clone();
        self.begin_reveal();
        let motion = CursorMotion::new(destination.clone(), destination)
            .with_impact(click)
            .with_ripple(self.presentation.style.ripple());
        let frames = animation::Frames::at(self.topology.refresh_hz());
        loop {
            let elapsed = frames.elapsed_ms();
            let pose = motion.pose(elapsed);
            let opacity = schedule::highlight_progress(elapsed, CURSOR_HIGHLIGHT_HOLD_MS);
            if self.draw(pose.ripple, target.as_ref(), opacity).is_err() {
                return;
            }
            if elapsed >= motion.total_ms().max(CURSOR_HIGHLIGHT_HOLD_MS) {
                let _ = self.draw(0.0, None, 0.0);
                return;
            }
            if frames.wait_unless(interrupt) == animation::Continuation::Stop {
                return;
            }
        }
    }

    /// One frame at full strength, with the card at whatever point of
    /// its reveal it has reached.
    fn draw(
        &self,
        ripple_phase: f64,
        target: Option<&Rect>,
        highlight_opacity: f64,
    ) -> Result<(), AdapterError> {
        self.paint(ripple_phase, target, highlight_opacity, 1.0)
    }

    /// One frame, dimmed to `overlay_opacity`.
    ///
    /// Fade after drawing the text because GDI writes text without alpha.
    ///
    /// The position and target bounds are already in physical pixels. Only
    /// the cursor's chrome is scaled for the monitor under its tip.
    fn paint(
        &self,
        ripple_phase: f64,
        target: Option<&Rect>,
        highlight_opacity: f64,
        overlay_opacity: f64,
    ) -> Result<(), AdapterError> {
        let monitor =
            monitors::monitor_for_point(self.topology.monitors(), &self.presentation.pose);
        let screen = monitor.map(|monitor| monitor.work_area).unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        });
        let shown = self
            .presentation
            .shown_style(monitor.map_or(1.0, |monitor| monitor.scale));
        let frame = render::Frame {
            tip: self.presentation.pose.clone(),
            style: &shown,
            ripple_phase,
            target: target.cloned(),
            highlight_opacity,
            label: self.presentation.label_pill(shown.size()),
            screen,
        };
        let mut composed = render::compose(&frame);
        if let (Some(text_rect), Some(label)) =
            (composed.text_rect, self.presentation.label.as_deref())
        {
            text::draw_label(
                &mut composed.surface,
                &text_rect,
                label,
                [1.0, 1.0, 1.0],
                LABEL_FONT_POINTS * shown.size(),
            );
        }
        if let Some(card) = composed.card_rect {
            fade::dim_region(&mut composed.surface, &card, self.card_opacity());
        }
        fade::dim_surface(&mut composed.surface, overlay_opacity);
        let result = self.window.present(
            composed.origin.x as i32,
            composed.origin.y as i32,
            composed.surface.width,
            composed.surface.height,
            &composed.surface.pixels,
        );
        self.window.pump();
        result
    }

    fn clear(&self) {
        self.window.hide();
        self.window.pump();
        self.caret.hide();
    }

    /// One quiet tick: pump the window, re-read the display topology, and
    /// fade the overlay away once it has been quiet long enough.
    ///
    /// Polling keeps display changes current without sharing state with the
    /// window procedure.
    pub(crate) fn rest(&mut self) {
        self.window.pump();
        self.topology.reprobe();
        if self.rest.resting {
            return;
        }
        if self.rest.quiet_since.elapsed() < self.idle_rest_delay {
            return;
        }
        self.fade_away();
    }

    /// Fades the whole overlay out and leaves the screen clear.
    ///
    /// Blocking for the length of the fade matches the reference, and the
    /// span is short enough that a control arriving inside it waits out
    /// the remainder rather than being lost - the next `apply` clears the
    /// resting flag and draws at full strength, so nothing has to unwind
    /// a half-finished fade.
    fn fade_away(&mut self) {
        let steps = REST_FADE_STEPS;
        let interval = Duration::from_millis(CURSOR_REST_FADE_MS / u64::from(steps));
        for step in 1..=steps {
            let _ = self.paint(0.0, None, 0.0, schedule::rest_fade(step, steps));
            std::thread::sleep(interval);
        }
        self.clear();
        self.rest.resting = true;
    }

    /// Adopts the label the control carries, and only from a control that
    /// carries one.
    ///
    /// `Enable` and `Present` say what the card should read; `Hide`,
    /// `Show` and `Disable` say nothing about it, and a `Show` after a
    /// `Hide` has to bring back the card that was there. So the label is
    /// replaced wholesale by those two - including with nothing, which is
    /// how a card goes away - and left alone by the rest. It used to be
    /// assigned only when a control carried one, so the first label ever
    /// set stayed on screen for the life of the renderer and every later
    /// action was narrated by a stale caption. It is bounded on the way
    /// in because this is the reading side of a pipe: what arrives has
    /// passed the transport's frame cap and nothing else.
    fn adopt_label(&mut self, control: &CursorOverlayControl) {
        if !matches!(
            control,
            CursorOverlayControl::Enable { .. } | CursorOverlayControl::Present { .. }
        ) {
            return;
        }
        let next = self.presentation.label_from(control).and_then(label::clamp);
        if next != self.presentation.label {
            self.presentation.reveal = Reveal::for_label(next.as_deref());
        }
        self.presentation.label = next;
    }

    /// Starts the card easing in, if one is waiting to.
    fn begin_reveal(&mut self) {
        self.presentation.reveal.begin();
    }

    /// Draws frames until the card has finished appearing. Nothing waits
    /// on this - the cursor has already arrived and the action has
    /// already been acknowledged - so a newer control takes it over.
    fn play_reveal(&mut self, target: Option<&Rect>, interrupt: &dyn Fn() -> bool) {
        let frames = animation::Frames::at(self.topology.refresh_hz());
        while self.presentation.reveal.is_playing() {
            if self.draw(0.0, target, 0.0).is_err() {
                return;
            }
            if frames.wait_unless(interrupt) == animation::Continuation::Stop {
                return;
            }
        }
        let _ = self.draw(0.0, target, 0.0);
    }

    /// How far through its reveal the card is, or fully present when it
    /// has never been revealed.
    fn card_opacity(&self) -> f64 {
        self.presentation.reveal.opacity()
    }

    /// True once the session has read finished twice running.
    pub(crate) fn session_finished(&mut self) -> bool {
        let reading = session_state::classify(session_state::read_manifest(&self.session_id));
        self.watch.observe(reading)
    }
}
