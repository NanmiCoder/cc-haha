use super::{CursorMotionProfile, CursorOverlayStyle};
use crate::{AdapterError, ErrorCode};
use serde::{Deserialize, Serialize};

pub const MAX_CURSOR_LABEL_WORDS: usize = 12;
pub const MAX_CURSOR_LABEL_BYTES: usize = 512;
const DEFAULT_CURSOR_LABEL_WORDS: usize = 6;

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CursorOverlayConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(default = "default_word_limit")]
    max_words: usize,
    #[serde(default)]
    style: CursorOverlayStyle,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    multi_agent: bool,
    #[serde(default, skip_serializing_if = "CursorMotionProfile::is_default")]
    motion: CursorMotionProfile,
}

impl CursorOverlayConfig {
    pub fn enabled(label: Option<String>, max_words: usize) -> Result<Self, AdapterError> {
        Self {
            enabled: true,
            label,
            max_words,
            style: CursorOverlayStyle::default(),
            multi_agent: false,
            motion: CursorMotionProfile::default(),
        }
        .validated()
    }

    pub fn with_style(mut self, style: CursorOverlayStyle) -> Result<Self, AdapterError> {
        self.style = style.validated()?;
        Ok(self)
    }

    pub fn with_motion(mut self, motion: CursorMotionProfile) -> Result<Self, AdapterError> {
        self.motion = motion.validated()?;
        Ok(self)
    }

    pub const fn motion(&self) -> &CursorMotionProfile {
        &self.motion
    }

    pub fn with_multi_agent(mut self, enabled: bool) -> Self {
        self.multi_agent = enabled;
        self
    }

    pub const fn is_multi_agent(&self) -> bool {
        self.multi_agent
    }

    pub const fn style(&self) -> &CursorOverlayStyle {
        &self.style
    }

    pub fn validated(mut self) -> Result<Self, AdapterError> {
        if !(1..=MAX_CURSOR_LABEL_WORDS).contains(&self.max_words) {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!(
                    "Agent cursor label word limit must be between 1 and {MAX_CURSOR_LABEL_WORDS}"
                ),
            ));
        }
        if !self.enabled && self.label.is_some() {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "Agent cursor label requires the agent cursor overlay to be enabled",
            ));
        }
        if self.label.as_deref().is_some_and(|label| {
            serde_json::to_string(label.trim()).map_or(true, |json| {
                json.len().saturating_sub(2) > MAX_CURSOR_LABEL_BYTES
            })
        }) {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!(
                    "Agent cursor label must be at most {MAX_CURSOR_LABEL_BYTES} bytes once JSON-escaped"
                ),
            ));
        }
        self.label = self
            .label
            .take()
            .and_then(|label| limit_words(label.trim(), self.max_words));
        self.style = std::mem::take(&mut self.style).validated()?;
        self.motion.validate()?;
        Ok(self)
    }

    pub const fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub const fn is_disabled(&self) -> bool {
        !self.enabled
    }

    pub fn label(&self) -> Option<&str> {
        self.label.as_deref()
    }

    pub const fn max_words(&self) -> usize {
        self.max_words
    }
}

impl Default for CursorOverlayConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            label: None,
            max_words: DEFAULT_CURSOR_LABEL_WORDS,
            style: CursorOverlayStyle::default(),
            multi_agent: false,
            motion: CursorMotionProfile::default(),
        }
    }
}

fn default_word_limit() -> usize {
    DEFAULT_CURSOR_LABEL_WORDS
}

fn limit_words(value: &str, max_words: usize) -> Option<String> {
    let words = value.split_whitespace().collect::<Vec<_>>();
    if words.is_empty() {
        return None;
    }
    if words.len() <= max_words {
        return Some(words.join(" "));
    }
    let mut limited = words[..max_words].join(" ");
    limited.push('…');
    Some(limited)
}
