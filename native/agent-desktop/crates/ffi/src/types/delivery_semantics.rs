use crate::types::{AdDeliveryDisposition, AdRetryDisposition};

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AdDeliverySemantics {
    pub delivery: i32,
    pub retry: i32,
}

pub const AD_DELIVERY_SEMANTICS_SIZE: usize = 8;

impl AdDeliverySemantics {
    pub(crate) fn from_core(value: agent_desktop_core::DeliverySemantics) -> Self {
        Self {
            delivery: AdDeliveryDisposition::from(value.delivery()) as i32,
            retry: AdRetryDisposition::from(value.retry()) as i32,
        }
    }

    pub(crate) const fn unknown() -> Self {
        Self {
            delivery: AdDeliveryDisposition::Unknown as i32,
            retry: AdRetryDisposition::Unknown as i32,
        }
    }
}

const _: () = assert!(std::mem::size_of::<AdDeliverySemantics>() == AD_DELIVERY_SEMANTICS_SIZE);
