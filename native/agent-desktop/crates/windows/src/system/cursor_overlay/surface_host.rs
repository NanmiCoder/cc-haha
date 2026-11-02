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
    CURSOR_HIGHLIGHT_HOLD_MS, CURSOR_IDLE_REST_MS, CURSOR_REST_FADE_MS, CursorMotion,
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
    watch: session_state::EndWatch,
    topology: DisplayTopology,
}

#[cfg(target_os = "windows")]
impl SurfaceHost {
    pub(crate) fn create(session_id: String) -> Result<Self, agent_desktop_core::AdapterError> {
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
    pub(crate) fn apply(&mut self, control: &CursorOverlayControl) {
        if self.rest.resting && control.is_caret_follow() {
            return;
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
                self.draw(0.0, None, 0.0);
            }
            CursorOverlayControl::Hide { .. } | CursorOverlayControl::Disable { .. } => {
                self.clear();
            }
            CursorOverlayControl::Present { instruction, .. } => match instruction.phase() {
                CursorPhase::Travel => {
                    self.presentation.depart(instruction.is_pointer());
                    self.travel(
                        instruction.destination().clone(),
                        instruction.target().cloned(),
                    );
                }
                CursorPhase::Drag => self.take_drag_origin(
                    instruction
                        .drag_from()
                        .unwrap_or_else(|| instruction.destination())
                        .clone(),
                    instruction.target().cloned(),
                ),
                phase @ (CursorPhase::Caret | CursorPhase::CaretFollow) => {
                    let accent = self.presentation.style.accent_rgb();
                    let follow = phase == CursorPhase::CaretFollow;
                    self.caret.place(instruction.target(), accent, follow);
                }
                CursorPhase::Effect => {}
            },
        }
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

    /// Travels to where a drag begins and stays there.
    ///
    /// The reference arms pointer tracking here, so its overlay follows
    /// the real pointer for the length of the drag and draws a trail
    /// behind it. This does not, and the reason is the platform's own
    /// rule rather than an omission: a drag is physical input, headed
    /// actions hand the pointer to the operator, and this overlay is
    /// suppressed for the rest of a session that takes one. Standing at
    /// the origin is the whole of what can be shown truthfully, and it is
    /// shown before the acknowledgement because a drag is a pre-dispatch
    /// control that its caller blocks on.
    fn take_drag_origin(&mut self, origin: Point, target: Option<Rect>) {
        self.presentation.depart(false);
        self.travel(origin, target);
    }

    /// Plays the motion core computed, then leaves the cursor at its
    /// destination. Deliberately unstoppable: this is the one loop an
    /// action is blocked on, so giving it up for a newer control would
    /// dispatch a click at wherever the cursor had got to.
    fn travel(&mut self, destination: Point, target: Option<Rect>) {
        self.caret
            .hide_when_leaving(&self.presentation.pose, &destination);
        let motion = CursorMotion::new(self.presentation.pose.clone(), destination.clone())
            .with_impact(false)
            .with_ripple(false);
        let frames = animation::Frames::at(self.topology.refresh_hz());
        loop {
            let elapsed = frames.elapsed_ms();
            self.presentation.pose = motion.pose(elapsed).point;
            self.draw(0.0, target.as_ref(), 0.0);
            if schedule::has_arrived(elapsed, motion.duration_ms()) {
                break;
            }
            frames.wait();
        }
        self.presentation.pose = destination;
        self.presentation.arrive();
        self.draw(0.0, target.as_ref(), 0.0);
        self.begin_reveal();
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
            self.draw(pose.ripple, target.as_ref(), opacity);
            if elapsed >= motion.total_ms().max(CURSOR_HIGHLIGHT_HOLD_MS) {
                self.draw(0.0, None, 0.0);
                return;
            }
            if frames.wait_unless(interrupt) == animation::Continuation::Stop {
                return;
            }
        }
    }

    /// One frame at full strength, with the card at whatever point of
    /// its reveal it has reached.
    fn draw(&self, ripple_phase: f64, target: Option<&Rect>, highlight_opacity: f64) {
        self.paint(ripple_phase, target, highlight_opacity, 1.0);
    }

    /// One frame, dimmed to `overlay_opacity`.
    ///
    /// Both fades happen here and after everything is drawn, which is
    /// forced rather than chosen: GDI writes the label's text with no
    /// alpha, so it may only be drawn where the card beneath it is
    /// already opaque. Fading the card before the text went on would put
    /// the glyphs onto transparency and then force them back to full
    /// strength - a card that appears to arrive complete while only its
    /// border catches up.
    ///
    /// The two monitor lookups are not one lookup done twice. The first
    /// asks which screen the cursor is on, to lay the card out inside its
    /// work area; the second asks which screen the composed surface's own
    /// corner falls on, to place the window in that monitor's physical
    /// pixels. A card near an edge routinely straddles the two.
    fn paint(
        &self,
        ripple_phase: f64,
        target: Option<&Rect>,
        highlight_opacity: f64,
        overlay_opacity: f64,
    ) {
        let screen = monitors::monitor_for_point(self.topology.monitors(), &self.presentation.pose)
            .map(|monitor| monitor.work_area)
            .unwrap_or(Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            });
        let shown = self.presentation.shown_style();
        let frame = render::Frame {
            tip: self.presentation.pose.clone(),
            style: &shown,
            ripple_phase,
            target: target.cloned(),
            highlight_opacity,
            label: self.presentation.label_pill(),
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
                LABEL_FONT_POINTS * self.presentation.style.size(),
            );
        }
        if let Some(card) = composed.card_rect {
            fade::dim_region(&mut composed.surface, &card, self.card_opacity());
        }
        fade::dim_surface(&mut composed.surface, overlay_opacity);
        self.window.raise();
        let _ = self.window.present(
            composed.origin.x as i32,
            composed.origin.y as i32,
            composed.surface.width,
            composed.surface.height,
            &composed.surface.pixels,
        );
        self.window.pump();
    }

    fn clear(&self) {
        let _ = self.window.present(0, 0, 1, 1, &[0u32]);
        self.window.pump();
        self.caret.hide();
    }

    /// One quiet tick: pump the window, re-read the display topology, and
    /// fade the overlay away once it has been quiet long enough.
    ///
    /// The monitors and refresh rate are sampled when the renderer starts
    /// and would otherwise stay fixed for its whole life, so a resolution
    /// change, a scale change or a monitor plugged in mid-session would
    /// leave every later frame mapped against a desktop that no longer
    /// exists. Re-probing on the idle tick is how that is noticed: the
    /// window procedure is a plain `DefWindowProcW` and handles no
    /// topology message, and a message handler could not reach this state
    /// anyway without sharing it across the callback boundary.
    pub(crate) fn rest(&mut self) {
        self.window.pump();
        self.topology.reprobe();
        if self.rest.resting {
            return;
        }
        if self.rest.quiet_since.elapsed() < Duration::from_millis(CURSOR_IDLE_REST_MS) {
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
            self.paint(0.0, None, 0.0, schedule::rest_fade(step, steps));
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
            self.draw(0.0, target, 0.0);
            if frames.wait_unless(interrupt) == animation::Continuation::Stop {
                return;
            }
        }
        self.draw(0.0, target, 0.0);
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
