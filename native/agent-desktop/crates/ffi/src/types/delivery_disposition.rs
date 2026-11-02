#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdDeliveryDisposition {
    Unknown = 0,
    NotDelivered = 1,
    DeliveryUncertain = 2,
    DeliveredUnverified = 3,
    DeliveredVerified = 4,
}

impl From<agent_desktop_core::DeliveryDisposition> for AdDeliveryDisposition {
    fn from(value: agent_desktop_core::DeliveryDisposition) -> Self {
        match value {
            agent_desktop_core::DeliveryDisposition::Unknown => Self::Unknown,
            agent_desktop_core::DeliveryDisposition::NotDelivered => Self::NotDelivered,
            agent_desktop_core::DeliveryDisposition::DeliveryUncertain => Self::DeliveryUncertain,
            agent_desktop_core::DeliveryDisposition::DeliveredUnverified => {
                Self::DeliveredUnverified
            }
            agent_desktop_core::DeliveryDisposition::DeliveredVerified => Self::DeliveredVerified,
        }
    }
}
