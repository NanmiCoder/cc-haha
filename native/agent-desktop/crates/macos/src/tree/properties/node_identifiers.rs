use agent_desktop_core::LocatorField;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NodeIdentifiers {
    pub(crate) ax_identifier: LocatorField<String>,
    pub(crate) ax_dom_identifier: LocatorField<String>,
}

impl NodeIdentifiers {
    #[cfg(test)]
    pub(crate) fn from_options(
        ax_identifier: Option<String>,
        ax_dom_identifier: Option<String>,
    ) -> Self {
        Self {
            ax_identifier: normalize_ax(option_field(ax_identifier)),
            ax_dom_identifier: normalize_dom(option_field(ax_dom_identifier)),
        }
    }

    pub(crate) fn from_fields(
        ax_identifier: LocatorField<String>,
        ax_dom_identifier: LocatorField<String>,
    ) -> Self {
        Self {
            ax_identifier: normalize_ax(ax_identifier),
            ax_dom_identifier: normalize_dom(ax_dom_identifier),
        }
    }
}

impl Default for NodeIdentifiers {
    fn default() -> Self {
        Self {
            ax_identifier: LocatorField::Absent,
            ax_dom_identifier: LocatorField::Absent,
        }
    }
}

#[cfg(test)]
fn option_field(value: Option<String>) -> LocatorField<String> {
    value
        .map(LocatorField::Known)
        .unwrap_or(LocatorField::Absent)
}

fn normalize_ax(field: LocatorField<String>) -> LocatorField<String> {
    normalize(
        field,
        crate::tree::properties::native_id::meaningful_native_id,
    )
}

fn normalize_dom(field: LocatorField<String>) -> LocatorField<String> {
    normalize(field, crate::tree::properties::native_id::meaningful_dom_id)
}

fn normalize(
    field: LocatorField<String>,
    normalize: impl FnOnce(Option<String>) -> Option<String>,
) -> LocatorField<String> {
    match field {
        LocatorField::Known(value) => normalize(Some(value))
            .map(LocatorField::Known)
            .unwrap_or(LocatorField::Absent),
        LocatorField::Absent => LocatorField::Absent,
        LocatorField::Unknown => LocatorField::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dual_identifiers_remain_distinct() {
        for (native, dom) in [("native-save", "dom-save"), ("_NS:42", "compose")] {
            let identifiers = NodeIdentifiers::from_options(Some(native.into()), Some(dom.into()));

            assert_eq!(
                identifiers.ax_identifier,
                LocatorField::Known(native.into())
            );
            assert_eq!(
                identifiers.ax_dom_identifier,
                LocatorField::Known(dom.into())
            );
        }
    }
}
