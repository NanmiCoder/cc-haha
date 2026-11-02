use super::*;

const ENVELOPE_DOCS: &[(&str, &str)] = &[
    ("AGENTS.md", include_str!("../../AGENTS.md")),
    (
        "docs/json-output.md",
        include_str!("../../docs/json-output.md"),
    ),
    (
        ".github/ISSUE_TEMPLATE/bug_report.yml",
        include_str!("../../.github/ISSUE_TEMPLATE/bug_report.yml"),
    ),
];

const ABI_DOCS: &[(&str, &str)] = &[
    ("README.md", include_str!("../../README.md")),
    (
        "skills/agent-desktop-ffi/references/build-and-link.md",
        include_str!("../../skills/agent-desktop-ffi/references/build-and-link.md"),
    ),
];

const FFI_HEADER: &str = include_str!("../../crates/ffi/include/agent_desktop.h");
const README: &str = include_str!("../../README.md");
const AGENTS_MD: &str = include_str!("../../AGENTS.md");
const HELD_INPUT_COMMANDS: &[&str] = &["key-down", "key-up", "mouse-down", "mouse-up"];

fn quoted_values_after<'a>(text: &'a str, marker: &str) -> Vec<&'a str> {
    text.match_indices(marker)
        .filter_map(|(at, _)| {
            let rest = text[at + marker.len()..].trim_start();
            let rest = rest.strip_prefix('"')?;
            rest.split('"').next()
        })
        .collect()
}

fn integers_after(text: &str, marker: &str) -> Vec<u32> {
    text.match_indices(marker)
        .filter_map(|(at, _)| {
            let digits: String = text[at + marker.len()..]
                .trim_start_matches([' ', '`', '=', '('])
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse().ok()
        })
        .collect()
}

#[test]
fn documented_envelope_versions_match_the_code_constant() {
    for (path, text) in ENVELOPE_DOCS {
        let found = [
            quoted_values_after(text, "\"version\":"),
            quoted_values_after(text, "version: "),
        ]
        .concat();
        assert!(
            !found.is_empty(),
            "{path} no longer shows an envelope version"
        );
        for version in found {
            assert_eq!(
                version,
                agent_desktop_core::response::output::ENVELOPE_VERSION,
                "{path} documents envelope version {version}"
            );
        }
    }
}

#[test]
fn documented_abi_major_matches_the_header() {
    let header_major = integers_after(FFI_HEADER, "#define AD_ABI_VERSION_MAJOR")[0];
    for (path, text) in ABI_DOCS {
        let found = [
            integers_after(text, "ad_init("),
            integers_after(text, "AD_ABI_VERSION_MAJOR"),
            integers_after(text, "AD_ABI_VERSION_MAJOR` is currently"),
            integers_after(text, "the ABI major, currently"),
            integers_after(text, "ABI major is"),
        ]
        .concat();
        assert!(!found.is_empty(), "{path} no longer states the ABI major");
        for major in found {
            assert_eq!(major, header_major, "{path} documents ABI major {major}");
        }
    }
}

#[test]
fn documented_command_counts_match_the_cli() {
    let total = cli_command_names()
        .iter()
        .filter(|name| name.as_str() != "help")
        .count();
    let operational = total - HELD_INPUT_COMMANDS.len();
    assert!(
        README.contains(&format!(
            "{total} command names, {operational} operational commands"
        )),
        "README.md must state {total} command names and {operational} operational commands"
    );
    assert!(
        AGENTS_MD.contains(&format!("{total} commands spanning")),
        "AGENTS.md must state {total} commands"
    );
    assert!(
        AGENTS_MD.contains(&format!(
            "{operational} of the {total} command names are operational"
        )),
        "AGENTS.md must state {operational} of the {total} command names are operational"
    );
}
