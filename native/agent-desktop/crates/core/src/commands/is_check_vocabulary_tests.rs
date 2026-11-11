use super::state;

/// Real drift guard: scans the core files that actually compare
/// against state tokens for a bare string literal bypassing the `state::`
/// module (`has_state(_, "literal")` or a `state == "literal"` closure
/// comparison), then asserts every literal found is a member of
/// `STATE_VOCABULARY`. Unlike the guard this replaces — which rebuilt its
/// expected set from the same `state::` constants it checked, so it could
/// never fail — this reads the actual source text, so a literal that
/// bypasses `state::` and drifts from the vocabulary is caught here.
#[test]
fn state_literal_call_sites_use_vocabulary_constants() {
    let src_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let scanned = [
        "actionability/mod.rs",
        "locator/mod.rs",
        "ref_action/ref_action_wait.rs",
        "commands/wait_predicate.rs",
        "commands/is_check.rs",
    ];
    for rel in scanned {
        let path = src_root.join(rel);
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{} unreadable: {e}", path.display()));
        for token in bare_state_literals(&source) {
            assert!(
                state::STATE_VOCABULARY.contains(&token.as_str()),
                "{} references bare state literal \"{token}\" that bypasses state::; \
                 use a state:: constant so vocabulary drift is caught at compile time",
                path.display()
            );
        }
    }
}

/// Proves the scanner in [`state_literal_call_sites_use_vocabulary_constants`]
/// actually detects a drifted literal instead of always returning an empty
/// (vacuously passing) list.
#[test]
fn bare_state_literal_scan_flags_bogus_tokens() {
    let source = r#"
        fn f(states: &[String]) -> bool {
            states.iter().any(|state| state == "zzz_not_a_real_state")
        }
    "#;
    let found = bare_state_literals(source);
    assert_eq!(found, vec!["zzz_not_a_real_state".to_string()]);
    assert!(!state::STATE_VOCABULARY.contains(&found[0].as_str()));
}

fn bare_state_literals(source: &str) -> Vec<String> {
    let markers = ["has_state(", "state == "];
    let mut tokens = Vec::new();
    for marker in markers {
        let mut cursor = 0usize;
        while let Some(relative) = source[cursor..].find(marker) {
            let after_marker = cursor + relative + marker.len();
            let statement_end = source[after_marker..]
                .find([')', ';', '\n'])
                .map_or(source.len(), |offset| after_marker + offset);
            let statement = &source[after_marker..statement_end];
            if let Some(open_quote) = statement.find('"') {
                let rest = &statement[open_quote + 1..];
                if let Some(close_quote) = rest.find('"') {
                    tokens.push(rest[..close_quote].to_string());
                }
            }
            cursor = after_marker;
        }
    }
    tokens
}
