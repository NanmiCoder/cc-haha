use super::{PointerDelivery, check::ActionabilityCheck, status::ActionabilityStatus};
use crate::{ErrorCode, Point, Rect};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct ActionabilityReport {
    pub(crate) actionable: bool,
    pub(crate) checks: Vec<ActionabilityCheck>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) verified_point: Option<Point>,
    #[serde(skip)]
    pub(crate) presentation_point: Option<Point>,
    #[serde(skip)]
    pub(crate) presentation_bounds: Option<Rect>,
    #[serde(skip)]
    pub(crate) pointer_delivery: PointerDelivery,
}

impl ActionabilityReport {
    pub(crate) fn from_checks(
        checks: Vec<ActionabilityCheck>,
        verified_point: Option<Point>,
        presentation_point: Option<Point>,
        presentation_bounds: Option<Rect>,
        pointer_delivery: PointerDelivery,
    ) -> Self {
        let actionable = checks.iter().all(|check| !is_blocking(check));
        Self {
            actionable,
            checks,
            verified_point,
            presentation_point,
            presentation_bounds,
            pointer_delivery,
        }
    }

    /// A blocking check carrying a terminal code is a permanent refusal;
    /// one without carries a transient, waitable gap. A permanent refusal
    /// outranks a transient gap regardless of which check ran first, so this
    /// returns the first blocking check that carries a code rather than the
    /// first blocking check outright.
    pub(crate) fn terminal_code(&self) -> Option<ErrorCode> {
        self.checks
            .iter()
            .filter(|check| is_blocking(check))
            .find_map(|check| check.terminal_code.clone())
    }

    /// Whether `stable` is the sole reason this report is not actionable.
    ///
    /// `stable_preflight`'s retry-by-sampling loop in `ref_action.rs` is
    /// worth entering only when nothing else is wrong: a disabled element,
    /// a policy refusal, or a genuinely hidden target will not resolve by
    /// waiting, but bounds not yet matching a stale snapshot hash might.
    pub(crate) fn only_blocking_check_is_stability(&self) -> bool {
        let mut blocking = self.checks.iter().filter(|check| is_blocking(check));
        matches!(blocking.next(), Some(check) if check.check == "stable")
            && blocking.next().is_none()
    }

    pub(crate) fn failure_reasons(&self) -> String {
        self.checks
            .iter()
            .filter(|check| is_blocking(check))
            .map(|check| {
                let reason = check.reason.as_deref().unwrap_or("failed");
                format!("{} ({reason})", check.check)
            })
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn is_blocking(check: &ActionabilityCheck) -> bool {
    matches!(check.status, ActionabilityStatus::Fail)
        || matches!(check.status, ActionabilityStatus::Unknown)
            && (check.check != "receives_events"
                || check
                    .hit_test
                    .as_ref()
                    .is_some_and(|evidence| evidence.occluded > 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(check: &'static str, terminal_code: Option<ErrorCode>) -> ActionabilityCheck {
        ActionabilityCheck {
            check,
            status: ActionabilityStatus::Fail,
            reason: None,
            occluder: None,
            terminal_code,
            hit_test: None,
            stability: None,
        }
    }

    #[test]
    fn terminal_check_outranks_an_earlier_non_terminal_one() {
        let report = ActionabilityReport::from_checks(
            vec![
                failed("enabled", None),
                failed("supported_action", Some(ErrorCode::PolicyDenied)),
            ],
            None,
            None,
            None,
            PointerDelivery::NotApplicable,
        );

        assert_eq!(report.terminal_code(), Some(ErrorCode::PolicyDenied));
    }

    #[test]
    fn sole_blocking_check_without_a_terminal_code_is_returned_unchanged() {
        let report = ActionabilityReport::from_checks(
            vec![failed("enabled", None)],
            None,
            None,
            None,
            PointerDelivery::NotApplicable,
        );

        assert_eq!(report.terminal_code(), None);
    }
}
