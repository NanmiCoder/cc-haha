use serde::{Deserialize, Serialize};

use crate::{ActionResult, DeliverySemantics, OperationTarget};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationReport {
    #[serde(flatten)]
    pub result: ActionResult,
    pub target: OperationTarget,
}

impl OperationReport {
    pub fn new(result: ActionResult, target: OperationTarget) -> Self {
        Self { result, target }
    }

    pub fn delivered_unverified(action: impl Into<String>, target: OperationTarget) -> Self {
        Self::new(ActionResult::delivered_unverified(action), target)
    }

    pub fn satisfied_without_delivery(action: impl Into<String>, target: OperationTarget) -> Self {
        Self::new(ActionResult::satisfied_without_delivery(action), target)
    }

    pub const fn disposition(&self) -> DeliverySemantics {
        self.result.disposition()
    }
}

#[cfg(test)]
#[path = "operation_report_tests.rs"]
mod tests;
