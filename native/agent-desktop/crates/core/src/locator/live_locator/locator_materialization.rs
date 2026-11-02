#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LocatorMaterialization {
    #[default]
    None,
    SelectedMatches,
    FullRefMap,
}
