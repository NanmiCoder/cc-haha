#[derive(Clone, Copy)]
pub(crate) struct ChildReadBudget {
    pub(crate) max_elements: usize,
    pub(crate) boundary: bool,
}

impl ChildReadBudget {
    pub(crate) fn inferred(max_elements: usize) -> Self {
        Self {
            max_elements,
            boundary: max_elements == 0,
        }
    }
}

impl From<usize> for ChildReadBudget {
    fn from(max_elements: usize) -> Self {
        Self::inferred(max_elements)
    }
}

/// A boundary node is read for its child count alone, purely to annotate how
/// much was left unobserved. On a renderer that materialises children lazily
/// that count is not cheap — asking for it can cost more than the traversal it
/// was describing, and a single one could consume an entire snapshot budget.
/// The count is therefore best-effort: it gets a small slice, and a boundary
/// that cannot afford one is still reported as truncated, just without a number.
const BOUNDARY_COUNT_BUDGET: std::time::Duration = std::time::Duration::from_millis(25);

/// The same reasoning applies when the children are about to be read: a count
/// that consumes the whole deadline starves the read it was meant to size, so
/// it never gets more than half of what is left.
pub(super) fn count_deadline(boundary: bool, deadline: std::time::Instant) -> std::time::Instant {
    let now = std::time::Instant::now();
    let budget = if boundary {
        BOUNDARY_COUNT_BUDGET
    } else {
        deadline.saturating_duration_since(now) / 2
    };
    deadline.min(now + budget)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn a_boundary_count_gets_only_a_slice_of_a_long_deadline() {
        let far = Instant::now() + Duration::from_secs(3);

        let bounded = count_deadline(true, far);

        assert!(
            bounded < far,
            "a boundary node is read for its count alone; letting one lazy renderer container \
             spend the whole snapshot budget on it is what this bound exists to prevent"
        );
        assert!(bounded <= Instant::now() + Duration::from_millis(60));
    }

    /// A slow responder that cannot answer a count must still leave the caller
    /// enough budget to read the values themselves.
    #[test]
    fn a_real_child_read_leaves_half_its_deadline_for_the_values() {
        let far = Instant::now() + Duration::from_secs(3);

        let bounded = count_deadline(false, far);
        let after = Instant::now();

        assert!(bounded < far);
        assert!(
            far.saturating_duration_since(bounded) >= far.saturating_duration_since(after) / 2,
            "the count may spend at most half of what was left when it was bounded"
        );
    }

    #[test]
    fn the_bound_never_extends_a_deadline_that_is_already_shorter() {
        let near = Instant::now() + Duration::from_millis(5);

        assert!(count_deadline(true, near) <= near);
    }

    #[test]
    fn a_boundary_requesting_label_children_still_gets_the_25ms_count_budget() {
        let far = Instant::now() + Duration::from_secs(3);
        let budget = super::super::child_read_plan::ChildReadPlan::boundary_aware(128, 5, 3, 3)
            .max_elements(false, true);
        assert_eq!(budget.max_elements, 5);

        let earliest = Instant::now() + BOUNDARY_COUNT_BUDGET;
        let bounded = count_deadline(budget.boundary, far);
        let latest = Instant::now() + BOUNDARY_COUNT_BUDGET;

        assert!(
            earliest <= bounded && bounded <= latest,
            "requesting a handful of label children at a boundary must keep the 25 ms count \
             slice, not fall back to the generous half-deadline budget"
        );
    }
}
