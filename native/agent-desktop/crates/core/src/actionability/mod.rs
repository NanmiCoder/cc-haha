mod check;
mod check_result;
mod evaluate;
mod evidence;
mod gates;
mod hit_test_evidence;
mod live;
mod occluder;
mod pointer_delivery;
pub(crate) mod pointer_timeout;
mod receives_events;
mod report;
mod requirements;
mod stability;
mod stability_evidence;
pub(crate) mod stability_sampler;
mod status;

#[cfg(test)]
pub(crate) use check::ActionabilityCheck;
#[cfg(test)]
pub(crate) use evaluate::check;
pub(crate) use gates::bounds_are_visible;
#[cfg(test)]
pub(crate) use gates::states_are_enabled;
#[cfg(test)]
pub(crate) use live::check_live;
pub(crate) use live::{
    LiveCheckTarget, check_live_with_stability, check_live_with_stability_or_gap,
};
pub(crate) use pointer_delivery::PointerDelivery;
pub(crate) use receives_events::require_receives_events;
pub(crate) use report::ActionabilityReport;
pub(crate) use stability::StabilityExpectation;
#[cfg(test)]
pub(crate) use status::ActionabilityStatus;

#[cfg(test)]
#[path = "actionability_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "actionability_live_tests.rs"]
mod live_tests;
