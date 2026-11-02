use super::{occluder::Occluder, status::ActionabilityStatus};
use crate::ErrorCode;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct ActionabilityCheck {
    pub(crate) check: &'static str,
    pub(crate) status: ActionabilityStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) occluder: Option<Occluder>,
    #[serde(skip)]
    pub(crate) terminal_code: Option<ErrorCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hit_test: Option<super::hit_test_evidence::HitTestEvidence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) stability: Option<super::stability_evidence::StabilityEvidence>,
}
