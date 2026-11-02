use crate::{
    AppError,
    adapter::PlatformAdapter,
    commands::combo::{ensure_combo_allowed, parse_combo_normalized},
};
use serde_json::Value;

pub struct KeyUpArgs {
    pub combo: String,
    pub force: bool,
}

pub fn execute(args: KeyUpArgs, adapter: &dyn PlatformAdapter) -> Result<Value, AppError> {
    let combo = parse_combo_normalized(&args.combo)?;
    ensure_combo_allowed(&combo, &args.combo, args.force, adapter)?;
    Err(crate::commands::input_hold_policy::reject(
        "key-up", "press",
    ))
}
