use crate::AppError;
use serde_json::{Value, json};

pub fn execute() -> Result<Value, AppError> {
    Ok(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "target": std::env::consts::ARCH,
        "os": std::env::consts::OS,
    }))
}
