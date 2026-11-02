use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LocatorActivationStats {
    pub attempted: bool,
    pub succeeded: bool,
    pub ready: bool,
}
