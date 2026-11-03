use agent_desktop_core::{AdapterError, MouseButton};

use crate::actions::chain::chain_delivery::DeliveryOutcome;
use crate::tree::AXElement;

pub(crate) enum ChainStep {
    Action(&'static str),
    SetBool {
        attr: &'static str,
        value: bool,
    },
    SetDynamic {
        attr: &'static str,
    },
    IncrementToDynamic,
    FocusThenClearByKeyboard,
    CustomWithDeadline {
        label: &'static str,
        func: fn(&AXElement, agent_desktop_core::Deadline) -> Result<DeliveryOutcome, AdapterError>,
    },
    CGClick {
        button: MouseButton,
        count: u32,
    },
}
