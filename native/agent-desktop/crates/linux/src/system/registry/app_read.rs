use super::registry_app::RegistryApp;
use serde_json::Value;

pub(in crate::system) enum AppRead {
    Listed(Box<RegistryApp>),
    Skipped(Value),
    Excluded,
}
