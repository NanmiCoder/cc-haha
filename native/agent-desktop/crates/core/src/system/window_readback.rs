use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowReadback {
    scope: &'static str,
    tolerance: Option<(f64, &'static str)>,
}

impl WindowReadback {
    pub const fn state(scope: &'static str) -> Self {
        Self {
            scope,
            tolerance: None,
        }
    }

    pub const fn geometry(scope: &'static str, tolerance: f64, units: &'static str) -> Self {
        Self {
            scope,
            tolerance: Some((tolerance, units)),
        }
    }

    pub(crate) fn details(&self) -> Value {
        match self.tolerance {
            Some((tolerance, units)) => json!({
                "verification_scope": self.scope,
                "tolerance": tolerance,
                "units": units,
            }),
            None => json!({ "verification_scope": self.scope }),
        }
    }
}
