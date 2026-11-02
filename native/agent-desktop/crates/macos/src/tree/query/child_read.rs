use crate::tree::AXElement;

use super::{
    child_page::read_paged_prefix, child_read_status::ChildReadStatus,
    child_source_availability::ChildSourceAvailability,
};

pub(crate) struct ChildRead {
    pub(crate) elements: Vec<AXElement>,
    pub(crate) total_count: usize,
    pub(crate) complete: bool,
    pub(crate) source_availability: ChildSourceAvailability,
    pub(crate) prefix_certain: bool,
    pub(crate) status: ChildReadStatus,
}

impl ChildRead {
    pub(crate) fn empty(complete: bool) -> Self {
        Self {
            elements: Vec::new(),
            total_count: 0,
            complete,
            source_availability: if complete {
                ChildSourceAvailability::Available
            } else {
                ChildSourceAvailability::Unknown
            },
            prefix_certain: complete,
            status: ChildReadStatus::default(),
        }
    }

    fn failed(status: ChildReadStatus) -> Self {
        Self {
            elements: Vec::new(),
            total_count: 0,
            complete: false,
            source_availability: ChildSourceAvailability::Unknown,
            prefix_certain: false,
            status,
        }
    }

    fn unavailable(status: ChildReadStatus) -> Self {
        Self {
            elements: Vec::new(),
            total_count: 0,
            complete: true,
            source_availability: ChildSourceAvailability::Unavailable,
            prefix_certain: true,
            status,
        }
    }

    fn indexed(
        mut elements: Vec<AXElement>,
        initial_count: usize,
        index: usize,
        final_count: Result<usize, i32>,
        mut status: ChildReadStatus,
    ) -> Self {
        let Ok(final_count) = final_count else {
            return Self::failed(status);
        };
        status.count_changed |= initial_count != final_count;
        let expected = usize::from(index < initial_count);
        let complete = !status.count_changed && elements.len() == expected;
        elements.truncate(expected);
        Self {
            elements,
            total_count: final_count,
            complete,
            source_availability: ChildSourceAvailability::Available,
            prefix_certain: complete,
            status,
        }
    }

    pub(crate) fn truncated(&self) -> bool {
        self.elements.len() < self.total_count
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::super::{child_read_budget::ChildReadBudget, child_read_telemetry as telemetry};
    use super::*;
    use crate::{tree::properties::ax_value, tree::properties::cf_type::created_cf_array};
    use accessibility_sys::{kAXErrorAttributeUnsupported, kAXErrorNoValue, kAXErrorSuccess};
    use core_foundation::{base::TCFType, string::CFString};
    use core_foundation_sys::base::{CFIndex, CFTypeRef};

    const CHILD_PAGE_SIZE: usize = 128;

    pub(crate) fn read_children(
        element: &AXElement,
        role: Option<&str>,
        budget: ChildReadBudget,
        deadline: std::time::Instant,
    ) -> ChildRead {
        super::super::child_source::read_resilient(
            crate::tree::properties::element::child_attributes(role),
            deadline,
            |attribute| read_attribute_children(element, attribute, budget, deadline),
        )
    }

    pub(crate) fn read_child_at(
        element: &AXElement,
        role: Option<&str>,
        index: usize,
        deadline: std::time::Instant,
    ) -> ChildRead {
        super::super::child_source::read_resilient(
            crate::tree::properties::element::child_attributes(role),
            deadline,
            |attribute| read_attribute_child_at(element, attribute, index, deadline),
        )
    }

    pub(crate) fn read_attribute_children(
        element: &AXElement,
        attribute: &str,
        budget: impl Into<ChildReadBudget>,
        deadline: std::time::Instant,
    ) -> ChildRead {
        let budget = budget.into();
        let (max_elements, boundary) = (budget.max_elements, budget.boundary);
        let count_deadline = super::super::child_read_budget::count_deadline(boundary, deadline);
        let mut status = ChildReadStatus::default();
        if check_deadline(deadline, &mut status).is_err() {
            return ChildRead::failed(status);
        }
        status.attempts += 1;
        let count = match child_count(element, attribute, count_deadline) {
            Ok(count) => count,
            Err(error) if is_absent_error(error) => {
                return ChildRead::unavailable(status);
            }
            Err(error) => {
                telemetry::record(&mut status, attribute, "initial_count", error, None);
                return read_without_count(element, attribute, max_elements, deadline, status);
            }
        };
        let requested = count.min(max_elements);
        let mut complete = true;
        let mut elements = match read_prefix(element, attribute, requested, deadline, &mut status) {
            Ok(elements) => elements,
            Err(error) => {
                telemetry::record(&mut status, attribute, "prefix", error, Some(count));
                complete = false;
                Vec::new()
            }
        };
        complete &= elements.len() == requested;
        let final_count = match stable_count(element, attribute, deadline, &mut status) {
            Ok(final_count) => final_count,
            Err(error) => {
                telemetry::record(&mut status, attribute, "stable_count", error, Some(count));
                complete = false;
                count
            }
        };
        if count != final_count {
            status.count_changed = true;
            complete = false;
            elements.truncate(final_count);
        }
        ChildRead {
            elements,
            total_count: final_count,
            complete,
            source_availability: ChildSourceAvailability::Available,
            prefix_certain: complete,
            status,
        }
    }

    fn read_attribute_child_at(
        element: &AXElement,
        attribute: &str,
        index: usize,
        deadline: std::time::Instant,
    ) -> ChildRead {
        let mut status = ChildReadStatus::default();
        if check_deadline(deadline, &mut status).is_err() {
            return ChildRead::failed(status);
        }
        status.attempts += 1;
        let initial_count = match child_count(element, attribute, deadline) {
            Ok(count) => count,
            Err(error) if is_absent_error(error) => return ChildRead::unavailable(status),
            Err(error) => {
                telemetry::record(&mut status, attribute, "initial_count", error, None);
                return ChildRead::failed(status);
            }
        };
        let elements = if index < initial_count {
            status.attempts += 1;
            match copy_page(element, attribute, index, 1, deadline) {
                Ok(elements) => elements,
                Err(error) => {
                    telemetry::record(
                        &mut status,
                        attribute,
                        "indexed_child",
                        error,
                        Some(initial_count),
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };
        if index < initial_count && elements.is_empty() {
            status.cursor_stalled = true;
        }
        let final_count = stable_count(element, attribute, deadline, &mut status);
        if let Err(error) = final_count {
            telemetry::record(
                &mut status,
                attribute,
                "stable_count",
                error,
                Some(initial_count),
            );
        }
        ChildRead::indexed(elements, initial_count, index, final_count, status)
    }

    /// A responder can serve the values of an attribute while failing to answer
    /// its count inside the count budget — Xcode does this for `AXWindows`. The
    /// count is only an optimisation, so a short read still proves the elements
    /// it returned; only a full page leaves the tail unknown.
    pub(super) fn read_without_count(
        element: &AXElement,
        attribute: &str,
        max_elements: usize,
        deadline: std::time::Instant,
        mut status: ChildReadStatus,
    ) -> ChildRead {
        if max_elements == 0 {
            return ChildRead::failed(status);
        }
        let elements = match read_prefix(element, attribute, max_elements, deadline, &mut status) {
            Ok(elements) => elements,
            Err(error) => {
                telemetry::record(&mut status, attribute, "prefix", error, None);
                return ChildRead::failed(status);
            }
        };
        let saturated = elements.len() == max_elements;
        ChildRead {
            total_count: elements.len() + usize::from(saturated),
            elements,
            complete: !saturated,
            source_availability: ChildSourceAvailability::Available,
            prefix_certain: !saturated,
            status,
        }
    }

    fn child_count(
        element: &AXElement,
        attribute: &str,
        deadline: std::time::Instant,
    ) -> Result<usize, i32> {
        let attribute = CFString::new(attribute);
        crate::tree::properties::ax_ipc::attribute_value_count(
            element,
            attribute.as_concrete_TypeRef(),
            deadline,
        )
    }

    fn read_prefix(
        element: &AXElement,
        attribute: &str,
        requested: usize,
        deadline: std::time::Instant,
        status: &mut ChildReadStatus,
    ) -> Result<Vec<AXElement>, i32> {
        let result = read_paged_prefix(requested, CHILD_PAGE_SIZE, |index, page_len| {
            check_deadline(deadline, status)
                .map_err(|_| accessibility_sys::kAXErrorCannotComplete)?;
            status.attempts += 1;
            copy_page(element, attribute, index, page_len, deadline)
        })?;
        status.cursor_stalled |= result.stalled;
        Ok(result.elements)
    }

    fn stable_count(
        element: &AXElement,
        attribute: &str,
        deadline: std::time::Instant,
        status: &mut ChildReadStatus,
    ) -> Result<usize, i32> {
        check_deadline(deadline, status).map_err(|_| accessibility_sys::kAXErrorCannotComplete)?;
        status.attempts += 1;
        child_count(element, attribute, deadline)
    }

    fn copy_page(
        element: &AXElement,
        attribute: &str,
        index: usize,
        max_values: usize,
        deadline: std::time::Instant,
    ) -> Result<Vec<AXElement>, i32> {
        let attribute = CFString::new(attribute);
        let index = CFIndex::try_from(index).map_err(|_| i32::MIN)?;
        let max_values = CFIndex::try_from(max_values).map_err(|_| i32::MIN)?;
        let (error, result) = crate::tree::properties::ax_ipc::copy_attribute_values(
            element,
            attribute.as_concrete_TypeRef(),
            index,
            max_values,
            deadline,
        );
        if error != kAXErrorSuccess {
            if !result.is_null() {
                drop(created_cf_array(result as CFTypeRef));
            }
            return Err(error);
        }
        if result.is_null() {
            return Ok(Vec::new());
        }
        let Some(array) = created_cf_array(result as CFTypeRef) else {
            return Err(i32::MIN);
        };
        let expected = array.len() as usize;
        let elements = array
            .into_iter()
            .filter_map(|value| ax_value::retained_ax_element(&value))
            .collect::<Vec<_>>();
        if elements.len() != expected {
            return Err(i32::MIN);
        }
        Ok(elements)
    }

    fn check_deadline(
        deadline: std::time::Instant,
        status: &mut ChildReadStatus,
    ) -> Result<(), ()> {
        crate::tree::locator_deadline::remaining(deadline)
            .map(|_| ())
            .map_err(|_| {
                status.health.deadline_exhausted = 1;
            })
    }

    pub(super) fn is_absent_error(error: i32) -> bool {
        error == kAXErrorAttributeUnsupported || error == kAXErrorNoValue
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::super::child_read_budget::ChildReadBudget;
    use super::*;

    pub(crate) fn read_children(
        _element: &AXElement,
        _role: Option<&str>,
        _budget: ChildReadBudget,
        _deadline: std::time::Instant,
    ) -> ChildRead {
        ChildRead::empty(true)
    }

    pub(crate) fn read_attribute_children(
        _element: &AXElement,
        _attribute: &str,
        _budget: impl Into<ChildReadBudget>,
        _deadline: std::time::Instant,
    ) -> ChildRead {
        ChildRead::empty(true)
    }

    pub(crate) fn read_child_at(
        _element: &AXElement,
        _role: Option<&str>,
        _index: usize,
        _deadline: std::time::Instant,
    ) -> ChildRead {
        ChildRead::empty(true)
    }
}

pub(crate) use imp::{read_attribute_children, read_child_at, read_children};

#[cfg(all(test, target_os = "macos"))]
#[path = "child_read_tests.rs"]
mod tests;
