use super::menu_popup::{MenuFamily, Node};

pub(in crate::system) struct Found<'a> {
    pub(in crate::system) root: &'a Node,
    pub(in crate::system) family: MenuFamily,
    pub(in crate::system) items: usize,
}
