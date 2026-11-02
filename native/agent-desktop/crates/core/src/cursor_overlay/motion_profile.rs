use super::timing::CURSOR_MOTION_BUDGET_MS;
use crate::{AdapterError, ErrorCode};
use serde::{Deserialize, Serialize};

pub(super) const DEFAULT_TRAVEL_MIN_MS: u64 = 90;
pub(super) const DEFAULT_TRAVEL_MAX_MS: u64 = 320;
const DEFAULT_BOW: f64 = 1.0;
const DEFAULT_OVERSHOOT: f64 = 0.035;
const DEFAULT_TREMOR: f64 = 1.1;
const MIN_TRAVEL_MS: u64 = 30;
const MAX_BOW: f64 = 3.0;
const MAX_OVERSHOOT: f64 = 0.15;
const MAX_TREMOR: f64 = 4.0;
const MAX_DWELL_MS: u64 = 300;

/// How the drawn agent cursor travels to its destination. Presentation only;
/// physical input keeps its own motion.
#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CursorMotionProfile {
    #[serde(
        default = "default_travel_min_ms",
        skip_serializing_if = "is_default_travel_min_ms"
    )]
    travel_min_ms: u64,
    #[serde(
        default = "default_travel_max_ms",
        skip_serializing_if = "is_default_travel_max_ms"
    )]
    travel_max_ms: u64,
    #[serde(default = "default_bow", skip_serializing_if = "is_default_bow")]
    bow: f64,
    #[serde(
        default = "default_overshoot",
        skip_serializing_if = "is_default_overshoot"
    )]
    overshoot: f64,
    #[serde(default = "default_tremor", skip_serializing_if = "is_default_tremor")]
    tremor: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    dwell_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seed: Option<u64>,
}

impl CursorMotionProfile {
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }

    pub fn validated(self) -> Result<Self, AdapterError> {
        self.validate()?;
        Ok(self)
    }

    pub fn validate(&self) -> Result<(), AdapterError> {
        if self.travel_min_ms < MIN_TRAVEL_MS || self.travel_min_ms > self.travel_max_ms {
            return Err(invalid(format!(
                "Cursor --travel-ms needs {MIN_TRAVEL_MS} <= MIN <= MAX"
            )));
        }
        check_range("--bow", self.bow, MAX_BOW)?;
        check_range("--overshoot", self.overshoot, MAX_OVERSHOOT)?;
        check_range("--tremor", self.tremor, MAX_TREMOR)?;
        if self.dwell_ms > MAX_DWELL_MS {
            return Err(invalid(format!(
                "Cursor --dwell-ms must be between 0 and {MAX_DWELL_MS}"
            )));
        }
        if self.travel_max_ms.saturating_add(self.dwell_ms) > CURSOR_MOTION_BUDGET_MS {
            return Err(invalid(format!(
                "Cursor travel max plus dwell must not exceed {CURSOR_MOTION_BUDGET_MS} ms"
            )));
        }
        Ok(())
    }

    pub fn set_travel_ms(&mut self, min: u64, max: u64) {
        self.travel_min_ms = min;
        self.travel_max_ms = max;
    }

    pub fn set_bow(&mut self, bow: f64) {
        self.bow = bow;
    }

    pub fn set_overshoot(&mut self, overshoot: f64) {
        self.overshoot = overshoot;
    }

    pub fn set_tremor(&mut self, tremor: f64) {
        self.tremor = tremor;
    }

    pub fn set_dwell_ms(&mut self, dwell_ms: u64) {
        self.dwell_ms = dwell_ms;
    }

    pub fn set_seed(&mut self, seed: Option<u64>) {
        self.seed = seed;
    }

    pub const fn travel_ms(&self) -> (u64, u64) {
        (self.travel_min_ms, self.travel_max_ms)
    }

    pub const fn bow(&self) -> f64 {
        self.bow
    }

    pub const fn overshoot(&self) -> f64 {
        self.overshoot
    }

    pub const fn tremor(&self) -> f64 {
        self.tremor
    }

    pub const fn dwell_ms(&self) -> u64 {
        self.dwell_ms
    }

    pub const fn seed(&self) -> Option<u64> {
        self.seed
    }
}

impl Default for CursorMotionProfile {
    fn default() -> Self {
        Self {
            travel_min_ms: DEFAULT_TRAVEL_MIN_MS,
            travel_max_ms: DEFAULT_TRAVEL_MAX_MS,
            bow: DEFAULT_BOW,
            overshoot: DEFAULT_OVERSHOOT,
            tremor: DEFAULT_TREMOR,
            dwell_ms: 0,
            seed: None,
        }
    }
}

fn check_range(flag: &str, value: f64, max: f64) -> Result<(), AdapterError> {
    if value.is_finite() && (0.0..=max).contains(&value) {
        Ok(())
    } else {
        Err(invalid(format!(
            "Cursor {flag} must be between 0 and {max}"
        )))
    }
}

fn invalid(message: String) -> AdapterError {
    AdapterError::new(ErrorCode::InvalidArgs, message)
}

const fn default_travel_min_ms() -> u64 {
    DEFAULT_TRAVEL_MIN_MS
}

const fn default_travel_max_ms() -> u64 {
    DEFAULT_TRAVEL_MAX_MS
}

const fn default_bow() -> f64 {
    DEFAULT_BOW
}

const fn default_overshoot() -> f64 {
    DEFAULT_OVERSHOOT
}

const fn default_tremor() -> f64 {
    DEFAULT_TREMOR
}

fn is_default_travel_min_ms(value: &u64) -> bool {
    *value == DEFAULT_TRAVEL_MIN_MS
}

fn is_default_travel_max_ms(value: &u64) -> bool {
    *value == DEFAULT_TRAVEL_MAX_MS
}

fn is_default_bow(value: &f64) -> bool {
    *value == DEFAULT_BOW
}

fn is_default_overshoot(value: &f64) -> bool {
    *value == DEFAULT_OVERSHOOT
}

fn is_default_tremor(value: &f64) -> bool {
    *value == DEFAULT_TREMOR
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}
