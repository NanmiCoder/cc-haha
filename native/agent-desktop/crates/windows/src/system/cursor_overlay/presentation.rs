//! What one composed frame is made of, and whether the overlay has gone quiet.
//!
//! Held apart from the host so the host file stays inside the size cap and so
//! the two pieces of per-frame state can be read without the paint path around
//! them.

#[cfg(target_os = "windows")]
pub(crate) use imp::{Presentation, RestState};

#[cfg(target_os = "windows")]
mod imp {
    use crate::system::cursor_overlay::reveal::Reveal;
    use agent_desktop_core::{
        CursorOverlayControl, CursorOverlayStyle, LABEL_FONT_POINTS, LabelPill, Point,
    };
    use std::time::Instant;

    /// The three things a frame is composed from, plus when the card began
    /// appearing, and whether the cursor shows its pointer image.
    ///
    /// The reveal instant belongs here rather than beside the rest state
    /// because it is a property of the label: it is set when the label
    /// changes and read while the card is drawn.
    pub(crate) struct Presentation {
        pub(crate) style: CursorOverlayStyle,
        pub(crate) pose: Point,
        pub(crate) label: Option<String>,
        pub(crate) reveal: Reveal,
        pointing: bool,
        arrives_pointing: bool,
    }

    impl Presentation {
        pub(crate) fn resting_at(pose: Point) -> Self {
            Self {
                style: CursorOverlayStyle::default(),
                pose,
                label: None,
                reveal: Reveal::Settled,
                pointing: false,
                arrives_pointing: false,
            }
        }

        /// The label a control asks the card to show. The greeting `Enable`
        /// sends is left off while the cursor is drawn from a custom image.
        pub(crate) fn label_from<'a>(&self, control: &'a CursorOverlayControl) -> Option<&'a str> {
            let greeting_over_image = control.is_enable() && self.style.image().is_some();
            control.label().filter(|_| !greeting_over_image)
        }

        /// A travel sets off showing the arrow, and arrives showing the
        /// pointer image when it lands on a pressable control.
        pub(crate) fn depart(&mut self, arrives_pointing: bool) {
            self.pointing = false;
            self.arrives_pointing = arrives_pointing;
        }

        pub(crate) fn arrive(&mut self) {
            self.pointing = std::mem::take(&mut self.arrives_pointing);
        }

        /// The label's pill, sized to the text as it is set at this size, or
        /// nothing when there is no label or it cannot be measured.
        pub(crate) fn label_pill(&self) -> Option<LabelPill> {
            let label = self.label.as_deref()?;
            let scale = self.style.size();
            let width = crate::system::cursor_overlay::text::measure_label(
                label,
                LABEL_FONT_POINTS * scale,
            )?;
            LabelPill::for_label(label, width, scale)
        }

        /// The style a frame is drawn with: the session's own, with the
        /// pointer image standing in for the arrow while the cursor rests on
        /// a pressable control.
        pub(crate) fn shown_style(&self) -> CursorOverlayStyle {
            let mut shown = self.style.clone();
            if self.pointing
                && let Some(pointer) = self.style.pointer_image()
            {
                shown.set_image(Some(pointer.clone()));
            }
            shown
        }
    }

    /// Whether the overlay has faded out, and how long it has been quiet.
    ///
    /// The overlay does not sit on screen indefinitely after the last
    /// instruction: it fades and orders itself away, and the next control
    /// brings it straight back at full strength.
    pub(crate) struct RestState {
        pub(crate) resting: bool,
        pub(crate) quiet_since: Instant,
    }
}
