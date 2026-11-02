use serde::{Deserialize, Serialize};

use crate::ProcessId;

/// How an application presents itself to the user, so an agent can tell a
/// window-owning app from one that only appears on a hotkey or lives in the
/// menu bar or tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppPresentation {
    /// Owns ordinary windows and appears in the Dock or taskbar.
    Foreground,
    /// No Dock or taskbar entry. Menu bar and tray items live here, as do
    /// overlays summoned by a hotkey; their windows may exist only while shown.
    Background,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub pid: ProcessId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<AppPresentation>,
}

impl AppInfo {
    /// Whether `id` identifies this application, by exact case-insensitive
    /// name or bundle identifier. The one predicate every launch-target
    /// match uses, so a name match and a bundle match never drift apart.
    pub fn matches_identifier(&self, id: &str) -> bool {
        app_name_matches(&self.name, id)
            || self
                .bundle_id
                .as_deref()
                .is_some_and(|bundle_id| bundle_id.eq_ignore_ascii_case(id))
    }
}

pub fn app_name_matches(actual: &str, expected: &str) -> bool {
    matches_exact_or_with_exe_suffix(actual, expected)
}

fn matches_exact_or_with_exe_suffix(actual: &str, expected: &str) -> bool {
    if matches_after_filtering(actual, expected) {
        return true;
    }
    if expected.ends_with(".exe") {
        return false;
    }
    let expected_with_exe = format!("{}.exe", expected);
    matches_after_filtering(actual, &expected_with_exe)
}

fn matches_after_filtering(actual: &str, expected: &str) -> bool {
    let mut actual_chars = actual
        .chars()
        .filter(|character| !crate::tree::search_text::is_bidirectional_control(*character));
    let mut expected_chars = expected
        .chars()
        .filter(|character| !crate::tree::search_text::is_bidirectional_control(*character));
    loop {
        match (actual_chars.next(), expected_chars.next()) {
            (Some(actual_char), Some(expected_char))
                if actual_char.eq_ignore_ascii_case(&expected_char) => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, bundle_id: Option<&str>) -> AppInfo {
        AppInfo {
            name: name.to_owned(),
            pid: ProcessId::new(1),
            bundle_id: bundle_id.map(str::to_owned),
            process_instance: None,
            presentation: None,
        }
    }

    #[test]
    fn matches_by_exact_name() {
        assert!(app("Fixture", None).matches_identifier("Fixture"));
    }

    #[test]
    fn matches_by_bundle_id() {
        assert!(
            app("Fixture", Some("com.example.fixture")).matches_identifier("com.example.fixture")
        );
    }

    #[test]
    fn matches_are_case_insensitive() {
        assert!(app("Fixture", None).matches_identifier("fixture"));
        assert!(
            app("Fixture", Some("com.example.Fixture")).matches_identifier("COM.EXAMPLE.FIXTURE")
        );
    }

    #[test]
    fn matches_name_with_bidirectional_formatting_controls() {
        assert!(app("\u{200e}WhatsApp", None).matches_identifier("WhatsApp"));
        assert!(app("WhatsApp", None).matches_identifier("\u{2067}WhatsApp\u{2069}"));
    }

    #[test]
    fn name_identity_remains_exact_after_bidi_controls_are_removed() {
        assert!(!app("Foo  Bar", None).matches_identifier("Foo Bar"));
        assert!(!app("WhatsApp Beta", None).matches_identifier("WhatsApp"));
        assert!(!app("WhatsApp!", None).matches_identifier("WhatsApp"));
    }

    #[test]
    fn does_not_match_an_unrelated_identifier() {
        assert!(!app("Fixture", Some("com.example.fixture")).matches_identifier("Other"));
    }

    #[test]
    fn matches_name_with_exe_suffix() {
        assert!(app("notepad.exe", None).matches_identifier("notepad"));
        assert!(app("notepad.exe", None).matches_identifier("notepad.exe"));
    }

    #[test]
    fn expected_exe_suffix_does_not_match_name_without_it() {
        assert!(!app("notepad", None).matches_identifier("notepad.exe"));
    }

    #[test]
    fn exe_suffix_matching_is_case_insensitive() {
        assert!(app("Notepad.EXE", None).matches_identifier("notepad"));
        assert!(app("NOTEPAD.exe", None).matches_identifier("Notepad"));
    }

    #[test]
    fn a_substring_of_a_name_does_not_match() {
        assert!(!app_name_matches("notepad.exe", "note"));
        assert!(!app_name_matches("notepad.exe", "pad"));
    }

    #[test]
    fn a_stem_matches_only_at_the_exe_boundary() {
        assert!(app_name_matches("notepad.exe", "notepad"));
        assert!(!app_name_matches("notepadx.exe", "notepad"));
    }

    #[test]
    fn a_name_without_the_suffix_still_matches_itself() {
        assert!(app_name_matches("TextEdit", "TextEdit"));
        assert!(!app_name_matches("TextEdit", "TextEd"));
    }
}
