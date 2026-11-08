/// Which kind of launcher a desktop entry describes and how it shows up.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct EntryTraits {
    pub(crate) application: bool,
    pub(crate) terminal: bool,
    pub(crate) hidden: bool,
    pub(crate) wm_class: Option<String>,
}
