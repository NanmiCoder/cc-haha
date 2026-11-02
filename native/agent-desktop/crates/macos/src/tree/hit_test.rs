#[cfg(target_os = "macos")]
mod imp {
    use crate::tree::{
        AXElement, element_bounds::read_bounds_with_deadline,
        properties::capabilities::same_element, properties::element::ABSOLUTE_MAX_DEPTH,
    };
    use accessibility_sys::{
        AXUIElementCreateSystemWide, kAXApplicationRole, kAXErrorSuccess, kAXRoleAttribute,
    };
    use agent_desktop_core::{
        AdapterError, Point, Rect, adapter::hit_test::HitTestResult,
        adapter::native_handle::NativeHandle,
    };

    /// Hit-tests `point` in the system-wide accessibility hierarchy, then
    /// classifies the frontmost result against `target`'s ancestor chain: a hit on
    /// `target` or a descendant reaches it, a hit outside that chain names a
    /// real occluder, and a hit on `target`'s own ancestor is retried against
    /// the owning application before remaining unknown.
    pub fn hit_test_impl(
        handle: &NativeHandle,
        point: Point,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        let deadline = crate::tree::locator_deadline::from_operation(deadline)?;
        hit_test_element(crate::adapter::ax_element(handle)?, point, deadline)
    }

    pub(crate) fn hit_test_ax_element(
        target: &AXElement,
        point: Point,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        let deadline = crate::tree::locator_deadline::from_operation(deadline)?;
        hit_test_element(target, point, deadline)
    }

    pub(crate) fn visible_bounds_ax_element(
        target: &AXElement,
        deadline: agent_desktop_core::Deadline,
    ) -> Result<Option<Rect>, AdapterError> {
        let deadline = crate::tree::locator_deadline::from_operation(deadline)?;
        clipped_bounds(target, deadline)
    }

    fn hit_test_element(
        target: &AXElement,
        point: Point,
        deadline: std::time::Instant,
    ) -> Result<HitTestResult, AdapterError> {
        let Some(bounds) = read_bounds_with_deadline(target, deadline)? else {
            return Ok(HitTestResult::Unknown);
        };
        if bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Ok(HitTestResult::Unknown);
        }
        if !clipping_is_complete(target, &point, deadline)? {
            return Ok(HitTestResult::Unknown);
        }
        let system = AXElement(unsafe { AXUIElementCreateSystemWide() });
        if system.0.is_null() {
            return Ok(HitTestResult::Unknown);
        }
        let Some(hit) = hit_at_position(&system, &point, deadline) else {
            return Ok(HitTestResult::Unknown);
        };
        let Some(classification) = classify_hit(target, &hit, deadline) else {
            return Ok(HitTestResult::Unknown);
        };
        if needs_application_retry(classification) {
            return Ok(hit_test_in_application(target, &point, deadline));
        }
        Ok(classification_result(classification, &hit, deadline))
    }

    fn hit_at_position(
        root: &AXElement,
        point: &Point,
        deadline: std::time::Instant,
    ) -> Option<AXElement> {
        let (error, hit) =
            crate::tree::properties::ax_ipc::element_at_position(root, ax_point(point), deadline);
        (error == kAXErrorSuccess && !hit.is_null()).then(|| AXElement(hit))
    }

    fn hit_test_in_application(
        target: &AXElement,
        point: &Point,
        deadline: std::time::Instant,
    ) -> HitTestResult {
        let Ok(pid) = crate::tree::properties::ax_ipc::pid(target, deadline) else {
            return HitTestResult::Unknown;
        };
        let application = crate::tree::element_for_pid(pid);
        let Some(hit) = hit_at_position(&application, point, deadline) else {
            return HitTestResult::Unknown;
        };
        match classify_hit(target, &hit, deadline) {
            Some(HitClassification::ReachesTarget) => HitTestResult::ReachesTarget,
            _ => HitTestResult::Unknown,
        }
    }

    fn classify_hit(
        target: &AXElement,
        hit: &AXElement,
        deadline: std::time::Instant,
    ) -> Option<HitClassification> {
        let limit = ABSOLUTE_MAX_DEPTH as usize;
        let reaches_target = if same_element(target, hit) {
            Ancestry::Found
        } else {
            ancestry(hit, target, limit, deadline)
        };
        if reaches_target == Ancestry::Incomplete {
            return None;
        }
        let is_ancestor_of_target = if reaches_target == Ancestry::Found {
            Ancestry::Absent
        } else {
            ancestry(target, hit, limit, deadline)
        };
        if is_ancestor_of_target == Ancestry::Incomplete {
            return None;
        }
        Some(classify_relation(
            reaches_target == Ancestry::Found,
            is_ancestor_of_target == Ancestry::Found,
        ))
    }

    fn classification_result(
        classification: HitClassification,
        hit: &AXElement,
        deadline: std::time::Instant,
    ) -> HitTestResult {
        match classification {
            HitClassification::ReachesTarget => HitTestResult::ReachesTarget,
            HitClassification::AncestorOfTarget => HitTestResult::Unknown,
            HitClassification::Unrelated => {
                intercepted_by(hit, deadline).unwrap_or(HitTestResult::Unknown)
            }
        }
    }

    pub(super) fn ax_point(point: &Point) -> (f32, f32) {
        (point.x as f32, point.y as f32)
    }

    pub(super) fn needs_application_retry(classification: HitClassification) -> bool {
        matches!(classification, HitClassification::AncestorOfTarget)
    }

    fn intercepted_by(
        hit: &AXElement,
        deadline: std::time::Instant,
    ) -> Result<HitTestResult, AdapterError> {
        let mut usage = crate::tree::observation_usage::ObservationUsage::new(
            agent_desktop_core::ObservationBudget::default(),
        );
        let ax_role =
            read_complete_text(hit, kAXRoleAttribute, deadline, &mut usage, "hit_test.role")?;
        let ax_subrole =
            read_complete_text(hit, "AXSubrole", deadline, &mut usage, "hit_test.subrole")?;
        let role = ax_role
            .as_deref()
            .map(|role| crate::tree::roles::ax_role_and_subrole_to_str(role, ax_subrole.as_deref()))
            .unwrap_or("unknown");
        Ok(HitTestResult::InterceptedBy {
            role: Some(role.to_string()),
            name: crate::tree::element_name::resolve_element_name(hit, deadline, &mut usage)?,
            bounds: read_bounds_with_deadline(hit, deadline)?,
        })
    }

    fn read_complete_text(
        element: &AXElement,
        attribute: &str,
        deadline: std::time::Instant,
        usage: &mut crate::tree::observation_usage::ObservationUsage,
        phase: &str,
    ) -> Result<Option<String>, AdapterError> {
        crate::tree::locator_deadline::prepare(element, deadline)?;
        match crate::tree::properties::attributes::copy_string_attr_bounded_result(
            element, attribute, deadline, usage,
        )
        .map_err(|error| crate::tree::query::read_error::semantic_read(error, phase))?
        {
            Some(value) if value.complete => Ok(Some(value.value)),
            Some(_) => Err(AdapterError::new(
                agent_desktop_core::ErrorCode::AppUnresponsive,
                "Hit-test text evidence exceeded its observation budget",
            )
            .with_details(serde_json::json!({
                "kind": "hit_test_text_incomplete",
                "attribute": attribute,
                "complete": false,
            }))),
            None => Ok(None),
        }
    }

    fn ancestry(
        start: &AXElement,
        expected: &AXElement,
        limit: usize,
        deadline: std::time::Instant,
    ) -> Ancestry {
        let mut current = start.clone();
        let mut visited = Vec::new();
        for _ in 0..limit {
            if !remember_ancestor(&mut visited, &current) {
                return Ancestry::Incomplete;
            }
            let parent = match crate::tree::resolve::resolve_ax_read::read_element(
                &current, "AXParent", deadline,
            ) {
                Ok(Some(parent)) => parent,
                Ok(None) => return Ancestry::Absent,
                Err(_) => return Ancestry::Incomplete,
            };
            if same_element(&parent, expected) {
                return Ancestry::Found;
            }
            current = parent;
        }
        Ancestry::Incomplete
    }

    fn clipping_is_complete(
        target: &AXElement,
        point: &Point,
        deadline: std::time::Instant,
    ) -> Result<bool, AdapterError> {
        Ok(clipped_bounds(target, deadline)?.is_some_and(|bounds| {
            point.x >= bounds.x
                && point.y >= bounds.y
                && point.x <= bounds.x + bounds.width
                && point.y <= bounds.y + bounds.height
        }))
    }

    fn clipped_bounds(
        target: &AXElement,
        deadline: std::time::Instant,
    ) -> Result<Option<Rect>, AdapterError> {
        let Some(mut visible) = read_bounds_with_deadline(target, deadline)? else {
            return Ok(None);
        };
        let mut current = target.clone();
        let mut visited = Vec::new();
        let mut usage = crate::tree::observation_usage::ObservationUsage::new(
            agent_desktop_core::ObservationBudget::default(),
        );
        for _ in 0..ABSOLUTE_MAX_DEPTH {
            if !remember_ancestor(&mut visited, &current) {
                return Ok(None);
            }
            let role = match read_complete_text(
                &current,
                kAXRoleAttribute,
                deadline,
                &mut usage,
                "hit_test.clip_role",
            ) {
                Ok(role) => role,
                Err(_) => return Ok(None),
            };
            if ends_clipping_walk(role.as_deref()) {
                return Ok(Some(visible));
            }
            if role.as_deref().is_some_and(clips_descendants) {
                let Some(bounds) = read_bounds_with_deadline(&current, deadline)? else {
                    return Ok(None);
                };
                let Some(intersection) = intersect_rects(visible, bounds) else {
                    return Ok(None);
                };
                visible = intersection;
            }
            current = match crate::tree::resolve::resolve_ax_read::read_element(
                &current, "AXParent", deadline,
            ) {
                Ok(Some(parent)) => parent,
                Ok(None) => return Ok(Some(visible)),
                Err(_) => return Ok(None),
            };
        }
        Ok(None)
    }

    use crate::tree::element_bounds::clips_descendants;
    pub(super) use crate::tree::element_bounds::intersect_rects;

    pub(super) fn remember_ancestor(visited: &mut Vec<AXElement>, current: &AXElement) -> bool {
        if visited
            .iter()
            .any(|ancestor| same_element(ancestor, current))
        {
            return false;
        }
        visited.push(current.clone());
        true
    }

    pub(super) fn ends_clipping_walk(role: Option<&str>) -> bool {
        role == Some(kAXApplicationRole)
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Ancestry {
        Found,
        Absent,
        Incomplete,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum HitClassification {
        ReachesTarget,
        AncestorOfTarget,
        Unrelated,
    }

    pub(super) fn classify_relation(
        reaches_target: bool,
        is_ancestor_of_target: bool,
    ) -> HitClassification {
        if reaches_target {
            HitClassification::ReachesTarget
        } else if is_ancestor_of_target {
            HitClassification::AncestorOfTarget
        } else {
            HitClassification::Unrelated
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use agent_desktop_core::{
        AdapterError, Point, adapter::hit_test::HitTestResult, adapter::native_handle::NativeHandle,
    };

    pub fn hit_test_impl(
        _handle: &NativeHandle,
        _point: Point,
        _deadline: agent_desktop_core::Deadline,
    ) -> Result<HitTestResult, AdapterError> {
        Err(AdapterError::not_supported("hit_test"))
    }
}

pub(crate) use imp::hit_test_impl;

#[cfg(target_os = "macos")]
pub(crate) use imp::{hit_test_ax_element, visible_bounds_ax_element};

#[cfg(all(test, target_os = "macos"))]
#[path = "hit_test_tests.rs"]
mod tests;
