use agent_desktop_core::AdapterError;

use super::chain_delivery_outcome::DeliveryOutcome;

pub(crate) struct Rung<'a> {
    pub(crate) label: &'static str,
    pub(crate) run: Box<dyn FnMut() -> Result<DeliveryOutcome, AdapterError> + 'a>,
}
