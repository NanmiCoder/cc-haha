#[cfg(target_os = "macos")]
mod imp {
    use std::{cell::RefCell, collections::HashMap};

    use accessibility_sys::{
        kAXDescriptionAttribute, kAXEnabledAttribute, kAXPlaceholderValueAttribute,
        kAXPositionAttribute, kAXRoleAttribute, kAXSizeAttribute, kAXSubroleAttribute,
        kAXTitleAttribute, kAXTitleUIElementAttribute, kAXValueAttribute,
    };
    use agent_desktop_core::EvidenceRequirements;
    use core_foundation::{
        array::CFArray,
        base::{CFTypeRef, TCFType},
        string::{CFString, CFStringRef},
    };

    pub(crate) const NODE_ATTRIBUTE_COUNT: u64 = 23;
    const NAMES: [&str; NODE_ATTRIBUTE_COUNT as usize] = [
        kAXRoleAttribute,
        kAXTitleAttribute,
        kAXDescriptionAttribute,
        kAXValueAttribute,
        kAXEnabledAttribute,
        "AXFocused",
        "AXExpanded",
        "AXDisclosing",
        "AXSelected",
        "AXHidden",
        "AXElementBusy",
        "AXModal",
        "AXRequired",
        "AXIdentifier",
        "AXDOMIdentifier",
        "AXLabelValue",
        kAXPlaceholderValueAttribute,
        kAXTitleUIElementAttribute,
        kAXPositionAttribute,
        kAXSizeAttribute,
        "AXVerticalScrollBar",
        "AXHorizontalScrollBar",
        kAXSubroleAttribute,
    ];

    struct AttributeNames {
        _names: Vec<CFString>,
        arrays: RefCell<HashMap<u32, CFArray<CFStringRef>>>,
    }

    impl AttributeNames {
        fn new() -> Self {
            let names = NAMES
                .iter()
                .map(|attribute| CFString::new(attribute))
                .collect::<Vec<_>>();
            Self {
                _names: names,
                arrays: RefCell::new(HashMap::new()),
            }
        }

        fn with_array<T>(&self, mask: u32, read: impl FnOnce(&CFArray<CFStringRef>) -> T) -> T {
            let mut arrays = self.arrays.borrow_mut();
            let array = arrays.entry(mask).or_insert_with(|| {
                let refs = self
                    ._names
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| mask & (1_u32 << index) != 0)
                    .map(|(_, attribute)| attribute.as_concrete_TypeRef())
                    .collect::<Vec<_>>();
                CFArray::from_copyable(&refs)
            });
            read(array)
        }
    }

    thread_local! {
        static ATTRIBUTE_NAMES: AttributeNames = AttributeNames::new();
    }

    pub(crate) fn copy_node_attribute_values(
        element: &crate::tree::AXElement,
        mask: u32,
        deadline: std::time::Instant,
    ) -> (i32, CFTypeRef) {
        ATTRIBUTE_NAMES.with(|names| {
            names.with_array(mask, |array| {
                crate::tree::properties::ax_ipc::copy_multiple_attribute_values(
                    element,
                    array.as_concrete_TypeRef(),
                    deadline,
                )
            })
        })
    }

    pub(crate) fn attribute_mask(requirements: EvidenceRequirements) -> u32 {
        use crate::tree::properties::node_attribute_status::{
            AX_DOM_IDENTIFIER, AX_IDENTIFIER, BUSY, DESCRIPTION, DISCLOSING, ENABLED, EXPANDED,
            FOCUSED, HIDDEN, HORIZONTAL_SCROLLBAR, LABEL, MODAL, PLACEHOLDER, POSITION, REQUIRED,
            ROLE, SELECTED, SIZE, SUBROLE, TITLE, TITLE_ELEMENT, VALUE, VERTICAL_SCROLLBAR,
            attribute_bit,
        };
        let mut mask = attribute_bit(ROLE) | attribute_bit(SUBROLE);
        if requirements.name || requirements.description {
            for index in [TITLE, DESCRIPTION, VALUE, LABEL, PLACEHOLDER, TITLE_ELEMENT] {
                mask |= attribute_bit(index);
            }
        }
        if requirements.value {
            mask |= attribute_bit(VALUE);
        }
        if requirements.identifiers {
            mask |= attribute_bit(AX_IDENTIFIER) | attribute_bit(AX_DOM_IDENTIFIER);
        }
        if requirements.states {
            for index in [
                VALUE, ENABLED, FOCUSED, EXPANDED, DISCLOSING, SELECTED, HIDDEN, BUSY, MODAL,
                REQUIRED, POSITION, SIZE,
            ] {
                mask |= attribute_bit(index);
            }
        }
        if requirements.ref_evidence.bounds {
            for index in [POSITION, SIZE] {
                mask |= attribute_bit(index);
            }
        }
        if requirements.ref_evidence.actions {
            for index in [VERTICAL_SCROLLBAR, HORIZONTAL_SCROLLBAR] {
                mask |= attribute_bit(index);
            }
        }
        mask
    }

    pub(crate) fn safe_attribute_mask(requirements: EvidenceRequirements) -> u32 {
        use crate::tree::properties::node_attribute_status::{VALUE, attribute_bit};
        attribute_mask(requirements) & !attribute_bit(VALUE)
    }

    pub(crate) fn should_read_value(
        requirements: EvidenceRequirements,
        role: Option<&str>,
        subrole: Option<&str>,
        role_complete: bool,
        subrole_complete: bool,
    ) -> bool {
        if !role_complete || !subrole_complete || role.is_none() {
            return false;
        }
        let secure = role == Some("AXSecureTextField") || subrole == Some("AXSecureTextField");
        if secure {
            return false;
        }
        requirements.value
            || (requirements.name && role == Some("AXStaticText"))
            || (requirements.states
                && role.is_some_and(|role| {
                    let canonical = crate::tree::roles::ax_role_and_subrole_to_str(role, subrole);
                    crate::tree::roles::is_toggleable_role(canonical) || canonical == "button"
                }))
    }

    pub(crate) fn requested_indices(mask: u32) -> impl Iterator<Item = usize> {
        (0..NODE_ATTRIBUTE_COUNT as usize).filter(move |index| mask & (1_u32 << index) != 0)
    }
}

#[cfg(test)]
pub(crate) use imp::NODE_ATTRIBUTE_COUNT;
#[cfg(target_os = "macos")]
#[cfg(test)]
pub(crate) use imp::attribute_mask;
pub(crate) use imp::{
    copy_node_attribute_values, requested_indices, safe_attribute_mask, should_read_value,
};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::tree::properties::node_attribute_status::{
        AX_DOM_IDENTIFIER, AX_IDENTIFIER, DESCRIPTION, LABEL, PLACEHOLDER, POSITION, ROLE, SIZE,
        SUBROLE, TITLE, TITLE_ELEMENT, VALUE,
    };
    use agent_desktop_core::EvidenceRequirements;

    #[test]
    fn role_plan_requests_role_and_subrole_instead_of_every_attribute() {
        let requirements = EvidenceRequirements {
            role: true,
            ..EvidenceRequirements::default()
        };

        assert_eq!(attribute_mask(requirements).count_ones(), 2);
        assert_eq!(
            attribute_mask(EvidenceRequirements::snapshot()).count_ones(),
            NODE_ATTRIBUTE_COUNT as u32
        );
    }

    #[test]
    fn name_plan_avoids_actions_bounds_states_and_identifiers() {
        let requirements = EvidenceRequirements {
            role: true,
            name: true,
            ..EvidenceRequirements::default()
        };
        let requested = requested_indices(attribute_mask(requirements)).collect::<Vec<_>>();

        assert_eq!(
            requested,
            [
                ROLE,
                TITLE,
                DESCRIPTION,
                VALUE,
                LABEL,
                PLACEHOLDER,
                TITLE_ELEMENT,
                SUBROLE
            ]
        );
    }

    #[test]
    fn role_only_selected_anchor_plan_is_exactly_six_cheap_attributes() {
        let mut requirements = EvidenceRequirements {
            role: true,
            identifiers: true,
            ..EvidenceRequirements::default()
        };
        requirements.ref_evidence.bounds = true;
        let requested = requested_indices(attribute_mask(requirements)).collect::<Vec<_>>();

        assert_eq!(
            requested,
            [
                ROLE,
                AX_IDENTIFIER,
                AX_DOM_IDENTIFIER,
                POSITION,
                SIZE,
                SUBROLE
            ]
        );
    }

    #[test]
    fn value_plan_never_fetches_secure_text_content() {
        let requirements = EvidenceRequirements::snapshot();

        assert!(!should_read_value(
            requirements,
            Some("AXTextField"),
            Some("AXSecureTextField"),
            true,
            true,
        ));
        assert!(should_read_value(
            requirements,
            Some("AXTextField"),
            None,
            true,
            true,
        ));
        assert!(!should_read_value(requirements, None, None, false, true,));
        assert!(!should_read_value(
            requirements,
            Some("AXTextField"),
            None,
            true,
            false,
        ));
        assert_eq!(
            safe_attribute_mask(requirements)
                & crate::tree::properties::node_attribute_status::attribute_bit(
                    crate::tree::properties::node_attribute_status::VALUE
                ),
            0
        );
    }
}
