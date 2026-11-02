pub(crate) const ALERT: u32 = 2;
pub(crate) const CHECK_BOX: u32 = 7;
pub(crate) const CHECK_MENU_ITEM: u32 = 8;
pub(crate) const COLOR_CHOOSER: u32 = 9;
pub(crate) const COMBO_BOX: u32 = 11;
pub(crate) const DIAL: u32 = 15;
pub(crate) const DIALOG: u32 = 16;
pub(crate) const FILE_CHOOSER: u32 = 19;
pub(crate) const FILLER: u32 = 20;
pub(crate) const FONT_CHOOSER: u32 = 22;
pub(crate) const FRAME: u32 = 23;
pub(crate) const PANEL: u32 = 39;
pub(crate) const PROGRESS_BAR: u32 = 42;
pub(crate) const SCROLL_BAR: u32 = 48;
pub(crate) const SCROLL_PANE: u32 = 49;
pub(crate) const SLIDER: u32 = 51;
pub(crate) const SPIN_BUTTON: u32 = 52;
pub(crate) const TABLE: u32 = 55;
pub(crate) const TREE: u32 = 65;
pub(crate) const TREE_TABLE: u32 = 66;
pub(crate) const WINDOW: u32 = 69;
pub(crate) const SECTION: u32 = 85;
pub(crate) const LEVEL_BAR: u32 = 103;
pub(crate) const LABEL: u32 = 29;
pub(crate) const LIST: u32 = 31;
pub(crate) const LIST_ITEM: u32 = 32;
pub(crate) const MENU: u32 = 33;
pub(crate) const MENU_BAR: u32 = 34;
pub(crate) const POPUP_MENU: u32 = 41;
pub(crate) const MENU_ITEM: u32 = 35;
pub(crate) const PAGE_TAB: u32 = 37;
pub(crate) const PASSWORD_TEXT: u32 = 40;
pub(crate) const PUSH_BUTTON: u32 = 43;
pub(crate) const RADIO_BUTTON: u32 = 44;
pub(crate) const RADIO_MENU_ITEM: u32 = 45;
pub(crate) const TERMINAL: u32 = 60;
pub(crate) const TEXT: u32 = 61;
pub(crate) const TOGGLE_BUTTON: u32 = 62;
pub(crate) const VIEWPORT: u32 = 68;
pub(crate) const APPLICATION: u32 = 75;
pub(crate) const ENTRY: u32 = 79;
pub(crate) const DOCUMENT_FRAME: u32 = 82;
pub(crate) const DOCUMENT_WEB: u32 = 95;
pub(crate) const NOTIFICATION: u32 = 101;
pub(crate) const LANDMARK: u32 = 110;
pub(crate) const PUSH_BUTTON_MENU: u32 = 129;

/// Whether a numeric role is a menu item: a plain row in a menu, a check or
/// radio row, all of which open their own submenu or run their own action.
pub(crate) fn is_menu_item(role: u32) -> bool {
    matches!(role, MENU_ITEM | CHECK_MENU_ITEM | RADIO_MENU_ITEM)
}

/// Whether a numeric role is a list, table or tree: a container of many rows.
pub(crate) fn is_bulk_container(role: Option<u32>) -> bool {
    matches!(role, Some(LIST | TABLE | TREE | TREE_TABLE))
}

/// Whether a numeric role opens a web document, below which DOM identifiers
/// and classes are read.
pub(crate) fn is_web_document(role: Option<u32>) -> bool {
    matches!(role, Some(DOCUMENT_WEB | DOCUMENT_FRAME))
}
