use super::role_numbers::CHECK_BOX;
use crate::tree::Field;
use crate::tree::properties::attributes::{AttributeRead, non_blank};

const GTK_TOOLKIT: &str = "GTK";
pub(crate) const GTK_SWITCH_ROLE_NAME: &str = "switch";

/// Whether a node is a GTK switch. GTK4 reports a switch as a check box whose
/// toolkit-local role name is `switch`; the name means nothing on another
/// toolkit, so the pair is matched only where the `toolkit` attribute is GTK.
pub(crate) fn is_gtk_switch(
    role: &Field<u32>,
    role_name: &Field<String>,
    attributes: &AttributeRead,
) -> bool {
    role.present() == Some(&CHECK_BOX)
        && role_name.present().map(String::as_str) == Some(GTK_SWITCH_ROLE_NAME)
        && non_blank(attributes, "toolkit") == Some(GTK_TOOLKIT)
}
