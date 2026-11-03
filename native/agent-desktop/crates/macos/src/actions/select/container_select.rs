pub(crate) const SELECTED: &str = "AXSelected";

/// Kept narrow so the settability probe never runs on generic containers.
pub(crate) fn role_activates_by_selection(role: &str) -> bool {
    matches!(
        role,
        "row" | "treeitem" | "cell" | "listitem" | "option" | "tab"
    )
}

#[cfg(any(target_os = "macos", test))]
fn verify_selection(
    delivered: bool,
    verify: impl FnOnce() -> bool,
) -> Result<bool, agent_desktop_core::AdapterError> {
    if !delivered {
        return Ok(false);
    }
    if verify() {
        return Ok(true);
    }
    Err(agent_desktop_core::AdapterError::new(
        agent_desktop_core::ErrorCode::ActionFailed,
        "Selection was delivered but its effect could not be verified",
    )
    .with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified())
    .with_suggestion("Inspect the selection before deciding whether to act again."))
}

#[cfg(target_os = "macos")]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline};
    use core_foundation::{array::CFArray, base::TCFType};

    use crate::actions::chain::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;

    use super::SELECTED;

    /// `AXOutline` and `AXTable` make `AXSelectedRows` writable; `AXList` and
    /// `AXBrowser` columns make `AXSelectedChildren` writable; a spreadsheet
    /// grid owns its cell selection through `AXSelectedCells` and refuses the
    /// other two. Most elements publish several of these names and accept
    /// writes to only one, so each write is verified by readback.
    const SELECTION_ATTRIBUTES: [&str; 3] =
        ["AXSelectedRows", "AXSelectedChildren", "AXSelectedCells"];
    const MAX_ANCESTOR_WALK: usize = 6;
    const MAX_SELECTION_READBACK: usize = 64;
    pub(crate) const SELECTION_SETTLE_MS: u64 = 300;
    pub(crate) const SELECTION_POLL_MS: u64 = 25;

    /// Reading the subrole would add nothing: no subrole moves an element into
    /// or out of this set, because the ones that redefine a native role keep a
    /// row a row and a cell a cell.
    pub(crate) fn element_activates_by_selection(element: &AXElement, deadline: Deadline) -> bool {
        crate::tree::properties::attributes::copy_string_attr_result(element, "AXRole", deadline)
            .ok()
            .flatten()
            .is_some_and(|role| {
                super::role_activates_by_selection(crate::tree::roles::ax_role_and_subrole_to_str(
                    &role, None,
                ))
            })
    }

    /// Every write is verified by readback. Which element to select depends on
    /// what the target is: a label is a stand-in for the row around it, while a
    /// row or a cell is the selectable thing itself.
    pub(crate) fn select_within_container(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        if select_member_directly(element, deadline)? {
            return Ok(DeliveryOutcome::DeliveredVerified);
        }
        if element_activates_by_selection(element, deadline) {
            return select_in_ancestor_containers(element, deadline);
        }
        climb_to_selectable_ancestor(element, deadline)
    }

    /// The target is selectable, so the search is for the container that owns
    /// its selection, never for a larger element to select instead. A
    /// spreadsheet keeps cell selection on the table two levels above the cell;
    /// selecting the row in between would answer a question nobody asked.
    fn select_in_ancestor_containers(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let mut container = element.clone();
        for _ in 0..MAX_ANCESTOR_WALK {
            let Some(parent) = parent_of(&container, deadline) else {
                return Ok(DeliveryOutcome::NotDelivered);
            };
            if select_member_in_container(&parent, element, deadline)? {
                return Ok(DeliveryOutcome::DeliveredVerified);
            }
            container = parent;
        }
        Ok(DeliveryOutcome::NotDelivered)
    }

    /// Climbs from the target because the clickable label is usually a
    /// descendant of the selectable row.
    fn climb_to_selectable_ancestor(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let mut member = element.clone();
        for _ in 0..MAX_ANCESTOR_WALK {
            let Some(parent) = parent_of(&member, deadline) else {
                return Ok(DeliveryOutcome::NotDelivered);
            };
            if select_member_in_container(&parent, &member, deadline)? {
                return Ok(DeliveryOutcome::DeliveredVerified);
            }
            member = parent;
            if select_member_directly(&member, deadline)? {
                return Ok(DeliveryOutcome::DeliveredVerified);
            }
        }
        Ok(DeliveryOutcome::NotDelivered)
    }

    fn select_member_directly(
        member: &AXElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        if !crate::actions::ax_helpers::is_attr_settable(member, SELECTED, deadline)? {
            return Ok(false);
        }
        let delivered =
            crate::actions::ax_helpers::set_ax_bool_or_err(member, SELECTED, true, deadline)?;
        super::verify_selection(delivered, || {
            crate::tree::properties::attributes::copy_bool_attr(member, SELECTED, deadline)
                == Some(true)
        })
    }

    fn select_member_in_container(
        container: &AXElement,
        member: &AXElement,
        deadline: Deadline,
    ) -> Result<bool, AdapterError> {
        for attribute in SELECTION_ATTRIBUTES {
            if !crate::actions::ax_helpers::is_attr_settable(container, attribute, deadline)? {
                continue;
            }
            let members = selection_array(member);
            let cf_attr = core_foundation::string::CFString::new(attribute);
            let error = crate::tree::properties::ax_ipc::set_attribute_value(
                container,
                cf_attr.as_concrete_TypeRef(),
                members.as_CFTypeRef(),
                deadline,
            )?;
            let delivered = crate::actions::ax_mutation::classify_result(
                container,
                attribute,
                "AXUIElementSetAttributeValue",
                error,
            )?;
            if super::verify_selection(delivered, || {
                holds_selection(container, member, attribute, deadline)
            })? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// `AXElement` does not implement `TCFType`, so the array is built through
    /// the CoreFoundation C API.
    fn selection_array(member: &AXElement) -> CFArray {
        let values = [member.0 as *const std::ffi::c_void];
        unsafe {
            let raw = core_foundation_sys::array::CFArrayCreate(
                std::ptr::null(),
                values.as_ptr(),
                1,
                &core_foundation_sys::array::kCFTypeArrayCallBacks,
            );
            CFArray::wrap_under_create_rule(raw)
        }
    }

    fn parent_of(element: &AXElement, deadline: Deadline) -> Option<AXElement> {
        crate::tree::properties::attributes::copy_element_attr_result(element, "AXParent", deadline)
            .ok()
            .flatten()
    }

    /// A selection write is applied asynchronously. The application answers the
    /// write at once and updates the attribute a moment later, so a single read
    /// reports failure for a selection the user can already see, and the chain
    /// then goes on writing selections that have nothing left to fix. The wait
    /// is bounded, and it only runs after a write the application accepted.
    fn holds_selection(
        container: &AXElement,
        member: &AXElement,
        attribute: &str,
        deadline: Deadline,
    ) -> bool {
        let settle_end =
            std::time::Instant::now() + std::time::Duration::from_millis(SELECTION_SETTLE_MS);
        loop {
            if selection_contains(container, member, attribute, deadline) {
                return true;
            }
            if deadline.is_expired() || std::time::Instant::now() >= settle_end {
                return false;
            }
            std::thread::sleep(
                deadline
                    .remaining()
                    .min(std::time::Duration::from_millis(SELECTION_POLL_MS)),
            );
        }
    }

    fn selection_contains(
        container: &AXElement,
        member: &AXElement,
        attribute: &str,
        deadline: Deadline,
    ) -> bool {
        crate::tree::properties::attributes::copy_ax_array_prefix_result(
            container,
            attribute,
            MAX_SELECTION_READBACK,
            deadline,
        )
        .ok()
        .flatten()
        .is_some_and(|selected| {
            selected
                .iter()
                .any(|entry| crate::tree::properties::capabilities::same_element(entry, member))
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline};

    use crate::actions::chain::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;

    pub(crate) fn select_within_container(
        _element: &AXElement,
        _deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        Ok(DeliveryOutcome::NotDelivered)
    }

    pub(crate) fn element_activates_by_selection(
        _element: &AXElement,
        _deadline: Deadline,
    ) -> bool {
        false
    }
}

pub(crate) use imp::{
    SELECTION_POLL_MS, SELECTION_SETTLE_MS, element_activates_by_selection, select_within_container,
};

#[cfg(test)]
mod tests {
    use super::role_activates_by_selection;

    #[test]
    fn a_spreadsheet_cell_is_a_selection_target_in_its_own_right() {
        for role in ["cell", "row", "treeitem", "option", "tab", "listitem"] {
            assert!(role_activates_by_selection(role));
        }
        for role in ["button", "textfield", "checkbox", "group", "table"] {
            assert!(!role_activates_by_selection(role));
        }
    }

    #[test]
    fn accepted_selection_with_failed_readback_never_authorizes_another_write() {
        let mut attempts = 0;
        let result: Result<bool, agent_desktop_core::AdapterError> = (|| {
            for verified in [false, true] {
                attempts += 1;
                if super::verify_selection(true, || verified)? {
                    return Ok(true);
                }
            }
            Ok(false)
        })();
        let error = result.unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(
            error.disposition,
            agent_desktop_core::DeliverySemantics::delivered_unverified()
        );
        assert_eq!(
            error.disposition.retry(),
            agent_desktop_core::RetryDisposition::Unsafe
        );
    }

    #[test]
    fn unsupported_selection_skips_readback_and_verified_selection_succeeds() {
        assert!(!super::verify_selection(false, || panic!("not delivered")).unwrap());
        assert!(super::verify_selection(true, || true).unwrap());
    }
}
