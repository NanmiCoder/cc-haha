use super::child_read_budget::ChildReadBudget;

#[derive(Clone, Copy)]
pub(crate) struct ChildReadPlan {
    max_elements: usize,
    boundary_elements: usize,
    logical_depth: Option<u8>,
    max_logical_depth: u8,
}

impl ChildReadPlan {
    pub(crate) fn load(max_elements: usize) -> Self {
        Self {
            max_elements,
            boundary_elements: max_elements,
            logical_depth: None,
            max_logical_depth: u8::MAX,
        }
    }

    pub(crate) fn boundary_aware(
        max_elements: usize,
        boundary_elements: usize,
        logical_depth: u8,
        max_logical_depth: u8,
    ) -> Self {
        Self {
            max_elements,
            boundary_elements,
            logical_depth: Some(logical_depth),
            max_logical_depth,
        }
    }

    /// The element count a read may load, paired with whether this call sits
    /// beyond the requested depth: a boundary read stays cheap even when it
    /// still needs a handful of children for label content, so the count
    /// probe backing it must be told explicitly rather than inferring
    /// boundary-ness from the count being zero.
    pub(crate) fn max_elements(
        self,
        transparent_wrapper: bool,
        names_from_children: bool,
    ) -> ChildReadBudget {
        let boundary = self.beyond_boundary(transparent_wrapper);
        let max_elements = if !boundary {
            self.max_elements
        } else if names_from_children {
            self.boundary_elements
        } else {
            0
        };
        ChildReadBudget {
            max_elements,
            boundary,
        }
    }

    fn beyond_boundary(self, transparent_wrapper: bool) -> bool {
        self.logical_depth.is_some_and(|depth| {
            depth.saturating_add(u8::from(!transparent_wrapper)) > self.max_logical_depth
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_nodes_request_only_the_native_child_count() {
        let plan = ChildReadPlan::boundary_aware(128, 0, 3, 3);

        let boundary = plan.max_elements(false, true);
        assert_eq!(boundary.max_elements, 0);
        assert!(boundary.boundary);

        let within = plan.max_elements(true, true);
        assert_eq!(within.max_elements, 128);
        assert!(!within.boundary);
    }

    #[test]
    fn selected_root_boundary_can_load_only_bounded_label_children() {
        let plan = ChildReadPlan::boundary_aware(128, 5, 0, 0);

        let budget = plan.max_elements(false, true);
        assert_eq!(budget.max_elements, 5);
        assert!(budget.boundary);
    }

    #[test]
    fn boundary_label_hydration_still_reports_as_a_boundary() {
        let plan = ChildReadPlan::boundary_aware(128, 5, 3, 3);

        let budget = plan.max_elements(false, true);

        assert_eq!(budget.max_elements, 5);
        assert!(
            budget.boundary,
            "a nonzero label read at the depth cutoff must still be tagged as a boundary \
             so its count probe keeps the tight budget"
        );
    }

    #[test]
    fn a_boundary_whose_role_takes_no_name_from_children_loads_none_of_them() {
        let plan = ChildReadPlan::boundary_aware(128, 5, 3, 3);

        let budget = plan.max_elements(false, false);

        assert_eq!(
            budget.max_elements, 0,
            "a scroll area or toolbar at the cutoff gains nothing from loading children \
             it will never read a label from"
        );
        assert!(budget.boundary);
    }

    #[test]
    fn actionable_group_cannot_load_past_the_boundary() {
        let plan = ChildReadPlan::boundary_aware(4_096, 0, 3, 3);
        let transparent = super::super::node_evidence::is_transparent_wrapper(
            Some("AXGroup"),
            None,
            &agent_desktop_core::NameEvidence::default(),
            None,
            &agent_desktop_core::IdentifierEvidence::absent(),
            &agent_desktop_core::LocatorField::Known(vec![
                agent_desktop_core::actions::capability::CLICK.into(),
            ]),
        );

        assert!(!transparent);
        let budget = plan.max_elements(transparent, true);
        assert_eq!(budget.max_elements, 0);
        assert!(budget.boundary);
    }
}
