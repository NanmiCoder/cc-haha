use zbus::zvariant::OwnedValue;

pub(super) struct ResolvedAction {
    pub name: String,
    pub target: Option<OwnedValue>,
}
