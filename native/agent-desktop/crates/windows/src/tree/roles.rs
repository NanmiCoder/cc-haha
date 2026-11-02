use agent_desktop_core::{LocatorField, Role};

use super::properties::ElementProperties;
use super::properties::property_ids::TreeProperty;
use super::properties::property_outcome::{PropertyOutcome, PropertyValue};

/// Resolves a canonical role from the read set.
///
/// A `ControlType` read that failed keeps its own [`PropertyOutcome::Unknown`]
/// shape all the way to [`LocatorField::Unknown`] - that is a failed read, not
/// evidence the element's role is [`Role::Unknown`]. Every other shape a
/// provider can answer with - a known id, or a read that came back `Absent`
/// or with a variant this crate does not model as a role source - resolves to
/// the typed `Role::Unknown`, which is a legitimate, positive answer about
/// the element rather than a missing one.
pub fn resolve_role(properties: &ElementProperties) -> LocatorField<String> {
    match properties.get(TreeProperty::ControlType) {
        PropertyOutcome::Unknown => LocatorField::Unknown,
        PropertyOutcome::Known(PropertyValue::Number(id)) => {
            LocatorField::Known(control_type_role(id, properties).as_str().to_string())
        }
        PropertyOutcome::Absent | PropertyOutcome::Known(_) => {
            LocatorField::Known(Role::Unknown.as_str().to_string())
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use agent_desktop_core::Role;
    use uiautomation::types::ControlType;

    use super::ElementProperties;
    use super::TreeProperty;

    /// Maps one `ControlType` id to the canonical `Role`, refined by the
    /// pattern availability this same walk already reads.
    ///
    /// An id the crate does not know is not a failed read - the caller
    /// already dispositioned that case from the property outcome - it is an
    /// id this build's `ControlType` cannot decode, which resolves to
    /// [`Role::Unknown`] the same as [`ControlType::Custom`] does.
    ///
    /// The match has no catch-all arm. Adding a `ControlType` variant to the
    /// `uiautomation` crate is therefore a build error here rather than a
    /// silent `Role::Unknown` for a type this map was never taught.
    pub(crate) fn control_type_role(id: i32, properties: &ElementProperties) -> Role {
        let Ok(control_type) = ControlType::try_from(id) else {
            return Role::Unknown;
        };
        match control_type {
            ControlType::Button => button_role(properties),
            ControlType::Calendar => Role::Group,
            ControlType::CheckBox => Role::Checkbox,
            ControlType::ComboBox => Role::ComboBox,
            ControlType::Edit => Role::TextField,
            ControlType::Hyperlink => Role::Link,
            ControlType::Image => Role::Image,
            ControlType::ListItem => Role::Option,
            ControlType::List => list_role(properties),
            ControlType::Menu => Role::Menu,
            ControlType::MenuBar => Role::Menu,
            ControlType::MenuItem => Role::MenuItem,
            ControlType::ProgressBar => Role::ProgressBar,
            ControlType::RadioButton => Role::RadioButton,
            ControlType::ScrollBar => Role::ScrollBar,
            ControlType::Slider => Role::Slider,
            ControlType::Spinner => Role::Incrementor,
            ControlType::StatusBar => Role::Status,
            ControlType::Tab => Role::TabList,
            ControlType::TabItem => Role::Tab,
            ControlType::Text => Role::StaticText,
            ControlType::ToolBar => Role::Toolbar,
            ControlType::ToolTip => Role::Tooltip,
            ControlType::Tree => Role::Outline,
            ControlType::TreeItem => Role::TreeItem,
            ControlType::Custom => custom_role(properties),
            ControlType::Group => Role::Group,
            ControlType::Thumb => Role::Handle,
            ControlType::DataGrid => Role::Grid,
            ControlType::DataItem => data_item_role(properties),
            ControlType::Document => document_role(properties),
            ControlType::SplitButton => Role::MenuButton,
            ControlType::Window => Role::Window,
            ControlType::Pane => pane_role(properties),
            ControlType::Header => Role::Group,
            ControlType::HeaderItem => Role::Column,
            ControlType::Table => Role::Table,
            ControlType::TitleBar => Role::Group,
            ControlType::Separator => Role::Separator,
            ControlType::SemanticZoom => Role::Group,
            ControlType::AppBar => Role::Toolbar,
        }
    }

    /// Roles the fixture is required to expose in one snapshot so every
    /// ref-able action this map produces has a regression-testable target -
    /// a closed list derived from this map rather than copied from macOS.
    /// Declared beside [`control_type_role`], alongside
    /// [`FIXTURE_UNCOVERED_ROLES`], so a `ControlType` arm added later that
    /// yields a role in neither set fails `roles_fixture_coverage_tests.rs`'s
    /// union test instead of silently going uncovered. That union test's own
    /// case table is pinned against a textual count of the `is_true`/
    /// `gated_flag` refinement calls this file makes, so a new refinement
    /// branch here cannot leave the case table stale without failing first.
    ///
    /// `#[cfg(test)]`: the only consumers today are that union test and its
    /// gate-count pin, so a non-test build carries no reference to it -
    /// marking it test-only rather than `#[allow(dead_code)]` says why
    /// plainly instead of silencing the lint.
    #[cfg(test)]
    pub(crate) const FIXTURE_COVERED_ROLES: &[&str] = &[
        "button",
        "cell",
        "checkbox",
        "combobox",
        "incrementor",
        "link",
        "listbox",
        "menubutton",
        "menuitem",
        "outline",
        "radiobutton",
        "row",
        "slider",
        "switch",
        "tab",
        "tablist",
        "textfield",
        "treeitem",
    ];

    /// Roles this map can produce that the fixture is not required to
    /// cover - either they carry no action this harness exercises, or the
    /// stock WinForms provider emits them unavoidably beside the fixture
    /// author's own controls (`group`, `statictext`, `image`, `menu`,
    /// `column`). `disclosure` and `scrollarea` are absent from both this
    /// list and [`FIXTURE_COVERED_ROLES`] for a different reason: no arm in
    /// this map ever produces either of them, so asserting either would
    /// assert a role this platform cannot produce.
    #[cfg(test)]
    pub(crate) const FIXTURE_UNCOVERED_ROLES: &[&str] = &[
        "column",
        "dialog",
        "document",
        "grid",
        "group",
        "handle",
        "image",
        "list",
        "menu",
        "option",
        "progressbar",
        "scrollbar",
        "separator",
        "statictext",
        "status",
        "table",
        "toolbar",
        "tooltip",
        "unknown",
        "window",
    ];

    /// `Button`, refined by the two patterns a plain push button never
    /// advertises. Checked in this order because a provider could in theory
    /// advertise both; `Toggle` is the stronger claim about the control's
    /// nature so it wins primary-role selection.
    fn button_role(properties: &ElementProperties) -> Role {
        if properties.is_true(TreeProperty::ToggleAvailable) {
            return Role::Switch;
        }
        if properties.is_true(TreeProperty::ExpandCollapseAvailable) {
            return Role::MenuButton;
        }
        Role::Button
    }

    /// `List`, refined by `Selection` availability: a list whose provider
    /// implements selection is a listbox, an unselectable list is a plain
    /// list.
    fn list_role(properties: &ElementProperties) -> Role {
        if properties.is_true(TreeProperty::SelectionAvailable) {
            Role::ListBox
        } else {
            Role::List
        }
    }

    /// `DataItem`, refined by `GridItem`/`TableItem` availability: an item
    /// addressable by row and column is a cell, otherwise it is the row that
    /// contains cells.
    fn data_item_role(properties: &ElementProperties) -> Role {
        if properties.is_true(TreeProperty::GridItemAvailable)
            || properties.is_true(TreeProperty::TableItemAvailable)
        {
            Role::Cell
        } else {
            Role::Row
        }
    }

    /// `Custom`, refined by `GridItem`/`TableItem` availability the same way
    /// [`data_item_role`] refines `DataItem`: WPF's `DataGrid` reports its
    /// cells as `ControlType.Custom` carrying those two patterns rather than
    /// `DataItem` (A16-10), so a `Custom` element addressable by row and
    /// column is the same `cell` shape under a different `ControlType`. A
    /// `Custom` element with neither pattern carries no signal this map acts
    /// on and stays [`Role::Unknown`].
    fn custom_role(properties: &ElementProperties) -> Role {
        if properties.is_true(TreeProperty::GridItemAvailable)
            || properties.is_true(TreeProperty::TableItemAvailable)
        {
            Role::Cell
        } else {
            Role::Unknown
        }
    }

    /// `Document`, refined by `Value` availability read through its gate: an
    /// editable document (a rich edit control, not a static viewer) is a
    /// text field, everything else stays a document.
    fn document_role(properties: &ElementProperties) -> Role {
        if properties.is_true(TreeProperty::ValueAvailable)
            && properties.gated_flag(TreeProperty::ValueIsReadOnly) == Some(false)
        {
            Role::TextField
        } else {
            Role::Document
        }
    }

    /// `Pane`, refined by `Window` availability or `IsDialog`: either one
    /// marks the pane as a dialog surface, and a plain pane with neither is a
    /// generic container.
    fn pane_role(properties: &ElementProperties) -> Role {
        if properties.is_true(TreeProperty::WindowAvailable)
            || properties.is_true(TreeProperty::IsDialog)
        {
            Role::Dialog
        } else {
            Role::Group
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use agent_desktop_core::Role;

    use super::ElementProperties;

    /// Exists only so `agent-desktop-windows` compiles on the Linux
    /// cross-check target used to prove this crate carries no unconditional
    /// platform leakage. The control-type map's own assertions - the
    /// exhaustive match, the ARIA containment table, the refinement gates -
    /// all run on the Windows lane, where `uiautomation::types::ControlType`
    /// exists to exercise them against.
    pub(crate) fn control_type_role(_id: i32, _properties: &ElementProperties) -> Role {
        Role::Unknown
    }
}

use imp::control_type_role;

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::{FIXTURE_COVERED_ROLES, FIXTURE_UNCOVERED_ROLES};

#[cfg(test)]
#[path = "roles_tests.rs"]
mod tests;
