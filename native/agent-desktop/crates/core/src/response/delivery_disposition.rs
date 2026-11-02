use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryDisposition {
    #[default]
    Unknown,
    NotDelivered,
    DeliveryUncertain,
    DeliveredUnverified,
    DeliveredVerified,
}
