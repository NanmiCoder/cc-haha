//! Which half of an element's identity `get --property text` should answer.
//!
//! This is deliberately **not** `roles::is_mutable_value_role`, which answers
//! a different question: whether a role's value changes during interaction and
//! so cannot serve as stable ref identity. Its true-branch includes `checkbox`,
//! `radiobutton`, `switch`, `slider` and `incrementor` - roles whose value is a
//! state token rather than something a person reads. Borrowing it would make a
//! checked checkbox named "Show hidden files" answer `1`, and a slider named
//! "Volume" answer a number: the same disappointment `text` was changed to
//! remove, moved to a role class at least as common.
//!
//! The match is exhaustive and has no catch-all arm, so a role added later
//! fails to compile until someone decides which side it belongs on.

use crate::Role;

/// True when the element's **value** is the content a person reads on it, so
/// `text` prefers the value and falls back to the accessible name. False when
/// the name is what is read - a button's label, a menu item's caption, a
/// slider's title - so `text` prefers the name and falls back to the value.
pub fn value_is_the_readable_text(role: &str) -> bool {
    match Role::from_token(role) {
        Role::ComboBox => true,
        Role::DateField => true,
        Role::ListBox => true,
        Role::TextField => true,
        Role::TimeField => true,

        Role::Alert => false,
        Role::AlertDialog => false,
        Role::Application => false,
        Role::Article => false,
        Role::Banner => false,
        Role::Browser => false,
        Role::Button => false,
        Role::Cell => false,
        Role::Checkbox => false,
        Role::ColorWell => false,
        Role::Column => false,
        Role::Complementary => false,
        Role::ContentInfo => false,
        Role::Definition => false,
        Role::Dialog => false,
        Role::Disclosure => false,
        Role::DockItem => false,
        Role::Document => false,
        Role::Drawer => false,
        Role::Form => false,
        Role::Grid => false,
        Role::Group => false,
        Role::Handle => false,
        Role::Heading => false,
        Role::HelpTag => false,
        Role::Image => false,
        Role::Incrementor => false,
        Role::LayoutItem => false,
        Role::LevelIndicator => false,
        Role::Link => false,
        Role::List => false,
        Role::Log => false,
        Role::Main => false,
        Role::Marquee => false,
        Role::Matte => false,
        Role::Math => false,
        Role::Menu => false,
        Role::MenuButton => false,
        Role::MenuItem => false,
        Role::Navigation => false,
        Role::Note => false,
        Role::Option => false,
        Role::Outline => false,
        Role::Page => false,
        Role::Paragraph => false,
        Role::Popover => false,
        Role::ProgressBar => false,
        Role::RadioButton => false,
        Role::RadioGroup => false,
        Role::Region => false,
        Role::RelevanceIndicator => false,
        Role::Row => false,
        Role::Ruler => false,
        Role::RulerMarker => false,
        Role::ScrollArea => false,
        Role::ScrollBar => false,
        Role::Search => false,
        Role::Separator => false,
        Role::Sheet => false,
        Role::Slider => false,
        Role::Splitter => false,
        Role::StaticText => false,
        Role::Status => false,
        Role::Switch => false,
        Role::Tab => false,
        Role::TabList => false,
        Role::TabPanel => false,
        Role::Table => false,
        Role::Term => false,
        Role::Timer => false,
        Role::Toolbar => false,
        Role::Tooltip => false,
        Role::TreeItem => false,
        Role::WebArea => false,
        Role::Window => false,
        Role::Unknown => false,
    }
}

#[cfg(test)]
#[path = "role_text_tests.rs"]
mod tests;
