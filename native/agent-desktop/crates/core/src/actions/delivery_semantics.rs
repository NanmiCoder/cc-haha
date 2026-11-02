use serde::{Deserialize, Deserializer, Serialize, Serializer, ser::SerializeStruct};

use crate::{DeliveryDisposition, RetryDisposition};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum DeliverySemantics {
    #[default]
    Unknown,
    NotDelivered,
    DeliveryUncertain,
    DeliveredUnverified,
    DeliveredVerified,
}

impl DeliverySemantics {
    pub const fn unknown() -> Self {
        Self::Unknown
    }

    pub const fn not_delivered() -> Self {
        Self::NotDelivered
    }

    pub const fn uncertain() -> Self {
        Self::DeliveryUncertain
    }

    pub const fn delivered_unverified() -> Self {
        Self::DeliveredUnverified
    }

    pub const fn delivered_verified() -> Self {
        Self::DeliveredVerified
    }

    pub const fn delivery(self) -> DeliveryDisposition {
        match self {
            Self::Unknown => DeliveryDisposition::Unknown,
            Self::NotDelivered => DeliveryDisposition::NotDelivered,
            Self::DeliveryUncertain => DeliveryDisposition::DeliveryUncertain,
            Self::DeliveredUnverified => DeliveryDisposition::DeliveredUnverified,
            Self::DeliveredVerified => DeliveryDisposition::DeliveredVerified,
        }
    }

    pub const fn retry(self) -> RetryDisposition {
        match self {
            Self::NotDelivered => RetryDisposition::Safe,
            Self::DeliveryUncertain | Self::DeliveredUnverified | Self::DeliveredVerified => {
                RetryDisposition::Unsafe
            }
            Self::Unknown => RetryDisposition::Unknown,
        }
    }
}

impl Serialize for DeliverySemantics {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("DeliverySemantics", 2)?;
        state.serialize_field("delivery", &self.delivery())?;
        state.serialize_field("retry", &self.retry())?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for DeliverySemantics {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let delivery = value
            .get("delivery")
            .cloned()
            .ok_or_else(|| serde::de::Error::missing_field("delivery"))?;
        let retry = value
            .get("retry")
            .cloned()
            .ok_or_else(|| serde::de::Error::missing_field("retry"))?;
        let delivery =
            DeliveryDisposition::deserialize(delivery).map_err(serde::de::Error::custom)?;
        let retry = RetryDisposition::deserialize(retry).map_err(serde::de::Error::custom)?;
        let semantics = match delivery {
            DeliveryDisposition::Unknown => Self::Unknown,
            DeliveryDisposition::NotDelivered => Self::NotDelivered,
            DeliveryDisposition::DeliveryUncertain => Self::DeliveryUncertain,
            DeliveryDisposition::DeliveredUnverified => Self::DeliveredUnverified,
            DeliveryDisposition::DeliveredVerified => Self::DeliveredVerified,
        };
        if semantics.retry() != retry {
            return Err(serde::de::Error::custom(
                "delivery and retry dispositions are inconsistent",
            ));
        }
        Ok(semantics)
    }
}

#[cfg(test)]
#[path = "delivery_semantics_tests.rs"]
mod tests;
