use super::{TrayTarget, item::ItemEvidence, menu_layout::Layout};

pub(crate) struct TrayItem {
    pub(crate) target: TrayTarget,
    pub(super) evidence: ItemEvidence,
    pub(crate) layout: Option<Layout>,
}
