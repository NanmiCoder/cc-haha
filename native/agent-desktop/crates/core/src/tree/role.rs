#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Role {
    Alert,
    AlertDialog,
    Application,
    Article,
    Banner,
    Browser,
    Button,
    Cell,
    Checkbox,
    ColorWell,
    Column,
    ComboBox,
    Complementary,
    ContentInfo,
    DateField,
    Definition,
    Dialog,
    Disclosure,
    DockItem,
    Document,
    Drawer,
    Form,
    Grid,
    Group,
    Handle,
    Heading,
    HelpTag,
    Image,
    Incrementor,
    LayoutItem,
    LevelIndicator,
    Link,
    List,
    ListBox,
    Log,
    Main,
    Marquee,
    Matte,
    Math,
    Menu,
    MenuButton,
    MenuItem,
    Navigation,
    Note,
    Option,
    Outline,
    Page,
    Paragraph,
    Popover,
    ProgressBar,
    RadioButton,
    RadioGroup,
    Region,
    RelevanceIndicator,
    Row,
    Ruler,
    RulerMarker,
    ScrollArea,
    ScrollBar,
    Search,
    Separator,
    Sheet,
    Slider,
    Splitter,
    StaticText,
    Status,
    Switch,
    Tab,
    TabList,
    TabPanel,
    Table,
    TextField,
    Term,
    TimeField,
    Timer,
    Toolbar,
    Tooltip,
    TreeItem,
    WebArea,
    Window,
    Unknown,
}

impl Role {
    pub fn from_token(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "alert" => Self::Alert,
            "alertdialog" => Self::AlertDialog,
            "application" => Self::Application,
            "article" => Self::Article,
            "banner" => Self::Banner,
            "browser" => Self::Browser,
            "button" => Self::Button,
            "cell" => Self::Cell,
            "checkbox" => Self::Checkbox,
            "colorwell" => Self::ColorWell,
            "column" => Self::Column,
            "combobox" => Self::ComboBox,
            "complementary" => Self::Complementary,
            "contentinfo" => Self::ContentInfo,
            "datefield" => Self::DateField,
            "definition" => Self::Definition,
            "dialog" => Self::Dialog,
            "disclosure" => Self::Disclosure,
            "dockitem" => Self::DockItem,
            "document" => Self::Document,
            "drawer" => Self::Drawer,
            "form" => Self::Form,
            "grid" => Self::Grid,
            "group" => Self::Group,
            "handle" => Self::Handle,
            "heading" => Self::Heading,
            "helptag" => Self::HelpTag,
            "image" => Self::Image,
            "incrementor" => Self::Incrementor,
            "layoutitem" => Self::LayoutItem,
            "levelindicator" => Self::LevelIndicator,
            "link" => Self::Link,
            "list" => Self::List,
            "listbox" => Self::ListBox,
            "log" => Self::Log,
            "main" => Self::Main,
            "marquee" => Self::Marquee,
            "matte" => Self::Matte,
            "math" => Self::Math,
            "menu" => Self::Menu,
            "menubutton" => Self::MenuButton,
            "menuitem" => Self::MenuItem,
            "navigation" => Self::Navigation,
            "note" => Self::Note,
            "option" => Self::Option,
            "outline" => Self::Outline,
            "page" => Self::Page,
            "paragraph" => Self::Paragraph,
            "popover" => Self::Popover,
            "progressbar" => Self::ProgressBar,
            "radiobutton" => Self::RadioButton,
            "radiogroup" => Self::RadioGroup,
            "region" => Self::Region,
            "relevanceindicator" => Self::RelevanceIndicator,
            "row" => Self::Row,
            "ruler" => Self::Ruler,
            "rulermarker" => Self::RulerMarker,
            "scrollarea" => Self::ScrollArea,
            "scrollbar" => Self::ScrollBar,
            "search" => Self::Search,
            "separator" => Self::Separator,
            "sheet" => Self::Sheet,
            "slider" => Self::Slider,
            "splitter" => Self::Splitter,
            "statictext" => Self::StaticText,
            "status" => Self::Status,
            "switch" => Self::Switch,
            "tab" => Self::Tab,
            "tablist" => Self::TabList,
            "tabpanel" => Self::TabPanel,
            "table" => Self::Table,
            "textfield" => Self::TextField,
            "term" => Self::Term,
            "timefield" => Self::TimeField,
            "timer" => Self::Timer,
            "toolbar" => Self::Toolbar,
            "tooltip" => Self::Tooltip,
            "treeitem" => Self::TreeItem,
            "webarea" => Self::WebArea,
            "window" => Self::Window,
            _ => Self::Unknown,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Alert => "alert",
            Self::AlertDialog => "alertdialog",
            Self::Application => "application",
            Self::Article => "article",
            Self::Banner => "banner",
            Self::Browser => "browser",
            Self::Button => "button",
            Self::Cell => "cell",
            Self::Checkbox => "checkbox",
            Self::ColorWell => "colorwell",
            Self::Column => "column",
            Self::ComboBox => "combobox",
            Self::Complementary => "complementary",
            Self::ContentInfo => "contentinfo",
            Self::DateField => "datefield",
            Self::Definition => "definition",
            Self::Dialog => "dialog",
            Self::Disclosure => "disclosure",
            Self::DockItem => "dockitem",
            Self::Document => "document",
            Self::Drawer => "drawer",
            Self::Form => "form",
            Self::Grid => "grid",
            Self::Group => "group",
            Self::Handle => "handle",
            Self::Heading => "heading",
            Self::HelpTag => "helptag",
            Self::Image => "image",
            Self::Incrementor => "incrementor",
            Self::LayoutItem => "layoutitem",
            Self::LevelIndicator => "levelindicator",
            Self::Link => "link",
            Self::List => "list",
            Self::ListBox => "listbox",
            Self::Log => "log",
            Self::Main => "main",
            Self::Marquee => "marquee",
            Self::Matte => "matte",
            Self::Math => "math",
            Self::Menu => "menu",
            Self::MenuButton => "menubutton",
            Self::MenuItem => "menuitem",
            Self::Navigation => "navigation",
            Self::Note => "note",
            Self::Option => "option",
            Self::Outline => "outline",
            Self::Page => "page",
            Self::Paragraph => "paragraph",
            Self::Popover => "popover",
            Self::ProgressBar => "progressbar",
            Self::RadioButton => "radiobutton",
            Self::RadioGroup => "radiogroup",
            Self::Region => "region",
            Self::RelevanceIndicator => "relevanceindicator",
            Self::Row => "row",
            Self::Ruler => "ruler",
            Self::RulerMarker => "rulermarker",
            Self::ScrollArea => "scrollarea",
            Self::ScrollBar => "scrollbar",
            Self::Search => "search",
            Self::Separator => "separator",
            Self::Sheet => "sheet",
            Self::Slider => "slider",
            Self::Splitter => "splitter",
            Self::StaticText => "statictext",
            Self::Status => "status",
            Self::Switch => "switch",
            Self::Tab => "tab",
            Self::TabList => "tablist",
            Self::TabPanel => "tabpanel",
            Self::Table => "table",
            Self::TextField => "textfield",
            Self::Term => "term",
            Self::TimeField => "timefield",
            Self::Timer => "timer",
            Self::Toolbar => "toolbar",
            Self::Tooltip => "tooltip",
            Self::TreeItem => "treeitem",
            Self::WebArea => "webarea",
            Self::Window => "window",
            Self::Unknown => "unknown",
        }
    }

    pub const fn is_interactive(self) -> bool {
        matches!(
            self,
            Self::Button
                | Self::Cell
                | Self::Checkbox
                | Self::ColorWell
                | Self::ComboBox
                | Self::DockItem
                | Self::Incrementor
                | Self::Link
                | Self::ListBox
                | Self::MenuButton
                | Self::MenuItem
                | Self::Option
                | Self::RadioButton
                | Self::Slider
                | Self::Switch
                | Self::Tab
                | Self::TextField
                | Self::TreeItem
        )
    }

    /// Controls a pointing hand hovers over: pressing them is their primary use.
    pub const fn is_pressable(self) -> bool {
        matches!(
            self,
            Self::Button
                | Self::Checkbox
                | Self::ColorWell
                | Self::Disclosure
                | Self::DockItem
                | Self::Incrementor
                | Self::Link
                | Self::MenuButton
                | Self::MenuItem
                | Self::Option
                | Self::RadioButton
                | Self::Switch
                | Self::Tab
                | Self::TreeItem
        )
    }

    /// Controls that take typed text, where a cursor shows the text caret rather than a hand.
    pub const fn takes_text(self) -> bool {
        matches!(self, Self::TextField | Self::ComboBox | Self::DateField)
    }

    pub const fn is_transparent_wrapper(self) -> bool {
        matches!(self, Self::Group)
    }

    pub fn is_canonical(value: &str) -> bool {
        let normalized = value.trim().to_ascii_lowercase();
        normalized == "unknown" || Self::from_token(&normalized) != Self::Unknown
    }
}

impl From<&str> for Role {
    fn from(value: &str) -> Self {
        Self::from_token(value)
    }
}

#[cfg(test)]
#[path = "role_tests.rs"]
mod tests;
