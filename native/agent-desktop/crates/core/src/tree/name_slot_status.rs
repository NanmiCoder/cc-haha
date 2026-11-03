/// Whether one name-evidence slot's value can be trusted, and whether it
/// applies to this element at all.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SlotStatus {
    /// The slot was read and its value is what it says.
    #[default]
    Certain,
    /// The read failed. The slot contributes uncertainty to every weaker
    /// source, because the value that would have won the precedence may be
    /// the one that is missing.
    Uncertain,
    /// The slot does not apply to this element on this platform, and
    /// contributes neither a value nor uncertainty.
    ///
    /// This is how a platform folds its own role-gating in **before** calling
    /// the shared precedence, instead of passing a platform role token into
    /// shared code. macOS admits `static_value` only for `AXStaticText`; every
    /// other role suppresses the slot, and suppressing it must also suppress
    /// the uncertainty of a `AXValue` read that was never going to be used.
    Suppressed,
}

/// The per-slot read outcome the shared name precedence consumes.
///
/// It carries no role and no notion of child completeness on purpose. Both are
/// platform concepts - a raw `AXStaticText` token, an adapter's own view of
/// whether it enumerated every child - and threading either through would put
/// a platform token inside shared code where no lint would catch it. Each
/// caller folds its own gating into these statuses first, so the shared
/// function is platform-neutral by construction rather than by discipline.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NameSlotStatus {
    pub explicit_label: SlotStatus,
    pub labelled_by_text: SlotStatus,
    pub native_title: SlotStatus,
    pub static_value: SlotStatus,
    pub child_label: SlotStatus,
    pub placeholder: SlotStatus,
    pub description: SlotStatus,
}

impl NameSlotStatus {
    /// Marks a slot uncertain when a read failed, leaving it certain when it
    /// did not - the shape every adapter needs at each call site.
    pub fn uncertain_if(failed: bool) -> SlotStatus {
        if failed {
            SlotStatus::Uncertain
        } else {
            SlotStatus::Certain
        }
    }
}
