//! Expand / Collapse via ExpandCollapsePattern with Known-opposite Invoke.
//!
//! LeafNode means the pattern is present but never expands (A19-2): the Expand
//! rung returns not-delivered without invoking, Invoke stays gated on a
//! Known-opposite state, and the chain exhausts honestly.

use agent_desktop_core::{ActionStep, AdapterError, Deadline, InteractionPolicy};
use std::time::{Duration, Instant};

use crate::actions::chain::{
    ALREADY_LABEL, ChainDef, ChainRung, DeliveryOutcome, INVOKE_LABEL, build_step,
    capped_verification_end, execute_chain,
};
use crate::tree::element::UIAElement;

pub(crate) const EXPAND_LABEL: &str = "ExpandCollapsePattern.Expand";
pub(crate) const COLLAPSE_LABEL: &str = "ExpandCollapsePattern.Collapse";

const DISCLOSURE_TIMEOUT: Duration = Duration::from_millis(200);
const POLL_SLICE: Duration = Duration::from_millis(20);

pub(crate) const DISCLOSURE_CHAIN: ChainDef = ChainDef {
    suggestion: "Refresh the snapshot and retry, or target an expandable container.",
    continue_after_unverified_delivery: false,
};

/// UIA `ExpandCollapseState` values (A15-7 / A19-1 / A19-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ExpandKind {
    Collapsed,
    Expanded,
    PartiallyExpanded,
    LeafNode,
}

impl ExpandKind {
    pub(crate) fn from_i32(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Collapsed),
            1 => Some(Self::Expanded),
            2 => Some(Self::PartiallyExpanded),
            3 => Some(Self::LeafNode),
            _ => None,
        }
    }

    fn is_target(self, want_expanded: bool) -> bool {
        matches!(
            (self, want_expanded),
            (Self::Expanded, true) | (Self::Collapsed, false)
        )
    }

    fn is_known_opposite(self, want_expanded: bool) -> bool {
        matches!(
            (self, want_expanded),
            (Self::Collapsed, true) | (Self::Expanded, false)
        )
    }

    fn is_leaf(self) -> bool {
        matches!(self, Self::LeafNode)
    }
}

/// Whether Invoke may fire: only a Known-opposite pre-read (never Unknown/Leaf).
pub(crate) fn invoke_allowed(current: Option<ExpandKind>, want_expanded: bool) -> bool {
    current.is_some_and(|state| state.is_known_opposite(want_expanded))
}

/// Satisfied / leaf / mutable plan from a pre-read (macOS disclosure_plan parity).
pub(crate) fn disclosure_plan(
    current: Option<ExpandKind>,
    want_expanded: bool,
) -> (bool, bool, bool) {
    let satisfied = current.is_some_and(|state| state.is_target(want_expanded));
    let leaf = current.is_some_and(ExpandKind::is_leaf);
    (satisfied, leaf, !satisfied && !leaf)
}

/// Injected disclosure inputs shared by the live path and unit-test seam.
pub(crate) struct DisclosureInput {
    pub(crate) want_expanded: bool,
    pub(crate) current: Option<ExpandKind>,
    pub(crate) pattern_ok: bool,
    pub(crate) invoke_ok: bool,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        ALREADY_LABEL, ActionStep, AdapterError, COLLAPSE_LABEL, ChainRung, DISCLOSURE_CHAIN,
        DISCLOSURE_TIMEOUT, Deadline, DeliveryOutcome, DisclosureInput, EXPAND_LABEL, ExpandKind,
        INVOKE_LABEL, Instant, InteractionPolicy, POLL_SLICE, UIAElement, build_step,
        capped_verification_end, disclosure_plan, execute_chain, invoke_allowed,
    };
    use crate::actions::chain::{
        after_delivery, gated, invoke_available, invoke_pattern_delivered,
    };
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_one;
    use uiautomation::patterns::UIExpandCollapsePattern;

    pub(crate) fn expand_steps(
        element: &UIAElement,
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        disclosure_steps(element, true, policy, deadline)
    }

    pub(crate) fn collapse_steps(
        element: &UIAElement,
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        disclosure_steps(element, false, policy, deadline)
    }

    fn disclosure_steps(
        element: &UIAElement,
        want_expanded: bool,
        policy: InteractionPolicy,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let pattern_ok = expand_collapse_available(element);
        let current = if pattern_ok {
            read_expand_state(element)
        } else {
            None
        };
        disclosure_judged_for(
            deadline,
            policy,
            DisclosureInput {
                want_expanded,
                current,
                pattern_ok,
                invoke_ok: invoke_available(element),
            },
            || {
                delivered_with_observe(element, want_expanded, deadline, |element| {
                    pattern_expand_collapse(element, want_expanded)
                })
            },
            || delivered_with_observe(element, want_expanded, deadline, invoke_pattern_delivered),
        )
    }

    /// Injected Expand/Collapse chain — unit-test seam and live path.
    pub(crate) fn disclosure_judged_for(
        deadline: Deadline,
        policy: InteractionPolicy,
        input: DisclosureInput,
        mut pattern: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
        mut invoke: impl FnMut() -> Result<DeliveryOutcome, AdapterError>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let (satisfied, _leaf, allow_pattern) = disclosure_plan(input.current, input.want_expanded);
        if satisfied {
            return Ok(vec![build_step(
                ALREADY_LABEL,
                DeliveryOutcome::SatisfiedNoDelivery,
            )]);
        }
        let label = if input.want_expanded {
            EXPAND_LABEL
        } else {
            COLLAPSE_LABEL
        };
        let allow_invoke = input.invoke_ok && invoke_allowed(input.current, input.want_expanded);
        let mut pattern_run = gated(input.pattern_ok && allow_pattern, &mut pattern);
        let mut invoke_run = gated(allow_invoke, &mut invoke);
        execute_chain(
            deadline,
            &DISCLOSURE_CHAIN,
            policy,
            &mut [
                ChainRung {
                    label,
                    requires_headed: false,
                    run: &mut pattern_run,
                },
                ChainRung {
                    label: INVOKE_LABEL,
                    requires_headed: false,
                    run: &mut invoke_run,
                },
            ],
        )
    }

    fn delivered_with_observe(
        element: &UIAElement,
        want_expanded: bool,
        deadline: Deadline,
        deliver: impl FnOnce(&UIAElement) -> Result<bool, AdapterError>,
    ) -> Result<DeliveryOutcome, AdapterError> {
        if !deliver(element)? {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        Ok(DeliveryOutcome::from_delivery(
            true,
            poll_target(want_expanded, deadline, element).map_err(after_delivery)?,
        ))
    }

    fn expand_collapse_available(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::ExpandCollapseAvailable).flag() == Some(true)
    }

    fn read_expand_state(element: &UIAElement) -> Option<ExpandKind> {
        read_one(element, TreeProperty::ExpandCollapseState)
            .number()
            .and_then(ExpandKind::from_i32)
    }

    fn pattern_expand_collapse(
        element: &UIAElement,
        want_expanded: bool,
    ) -> Result<bool, AdapterError> {
        let label = if want_expanded {
            EXPAND_LABEL
        } else {
            COLLAPSE_LABEL
        };
        match element.0.get_pattern::<UIExpandCollapsePattern>() {
            Ok(pattern) => {
                let result = if want_expanded {
                    pattern.expand()
                } else {
                    pattern.collapse()
                };
                match result {
                    Ok(()) => classify_success(),
                    Err(error) => classify_write(
                        if want_expanded { "Expand" } else { "Collapse" },
                        label,
                        &error,
                    ),
                }
            }
            Err(error) => classify_write("get_pattern", label, &error),
        }
    }

    /// Reads `ExpandCollapseAvailable` once before the loop rather than on
    /// every tick: the pattern's availability cannot legitimately flip mid-
    /// verification, so re-reading it 10 times over 200ms bought nothing.
    fn poll_target(
        want_expanded: bool,
        deadline: Deadline,
        element: &UIAElement,
    ) -> Result<bool, AdapterError> {
        deadline.ensure_remaining()?;
        let end = capped_verification_end(deadline, DISCLOSURE_TIMEOUT)?;
        let pattern_ok = expand_collapse_available(element);
        loop {
            let current = if pattern_ok {
                read_expand_state(element)
            } else {
                None
            };
            if current.is_some_and(|state| state.is_target(want_expanded)) {
                return Ok(true);
            }
            if Instant::now() >= end {
                return Ok(false);
            }
            std::thread::sleep(deadline.remaining_slice(POLL_SLICE)?);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionStep, AdapterError, Deadline, InteractionPolicy, UIAElement};

    pub(crate) fn expand_steps(
        _: &UIAElement,
        _: InteractionPolicy,
        _: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Expand"))
    }

    pub(crate) fn collapse_steps(
        _: &UIAElement,
        _: InteractionPolicy,
        _: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Collapse"))
    }
}

pub(crate) use imp::{collapse_steps, expand_steps};

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::disclosure_judged_for;

#[cfg(all(test, target_os = "windows"))]
#[path = "disclosure_tests.rs"]
mod tests;
