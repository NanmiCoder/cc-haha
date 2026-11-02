/// Files the `get_pattern` ban is lifted for. Each entry must still contain a
/// live call site — the per-entry tripwire deletes a dead exception rather
/// than leave it widening the ban for nothing.
const PATTERN_ALLOWLIST: &[&str] = &[
    "actions/scroll_into_view.rs",
    "actions/scroll_ladder.rs",
    "actions/dispatch.rs",
    "actions/value_write.rs",
    "actions/toggle_state.rs",
    "actions/disclosure.rs",
    "actions/select.rs",
    "actions/select_search.rs",
    "actions/scroll.rs",
];

const HIT_TEST_FAMILY: [(&str, &str); 3] = [
    ("tree/hit_test/mod.rs", include_str!("hit_test/mod.rs")),
    (
        "tree/hit_test/hit_test_classify.rs",
        include_str!("hit_test/hit_test_classify.rs"),
    ),
    (
        "tree/hit_test/hit_test_corroborate.rs",
        include_str!("hit_test/hit_test_corroborate.rs"),
    ),
];

const GATE_SUPPORT: [(&str, &str); 10] = [
    (
        "actions/scroll_into_view.rs",
        include_str!("../actions/scroll_into_view.rs"),
    ),
    (
        "actions/scroll_ladder.rs",
        include_str!("../actions/scroll_ladder.rs"),
    ),
    (
        "actions/dispatch.rs",
        include_str!("../actions/dispatch.rs"),
    ),
    (
        "actions/value_write.rs",
        include_str!("../actions/value_write.rs"),
    ),
    (
        "actions/toggle_state.rs",
        include_str!("../actions/toggle_state.rs"),
    ),
    (
        "actions/disclosure.rs",
        include_str!("../actions/disclosure.rs"),
    ),
    ("actions/select.rs", include_str!("../actions/select.rs")),
    (
        "actions/select_search.rs",
        include_str!("../actions/select_search.rs"),
    ),
    ("actions/scroll.rs", include_str!("../actions/scroll.rs")),
    (
        "system/window/window_resolve.rs",
        include_str!("../system/window/window_resolve.rs"),
    ),
];

/// Macros the occluder-evidence path may invoke. `matches!` expands to a
/// `match` yielding a `bool`; it has no way to build a string.
const NON_RENDERING_MACROS: [&str; 1] = ["matches"];

fn scanned() -> impl Iterator<Item = (&'static str, &'static str)> {
    HIT_TEST_FAMILY.into_iter().chain(GATE_SUPPORT)
}

fn allowlisted(name: &str) -> bool {
    PATTERN_ALLOWLIST.contains(&name)
}

fn source_for_allowlist_entry(entry: &str) -> Option<&'static str> {
    GATE_SUPPORT
        .iter()
        .find(|(name, _)| *name == entry)
        .map(|(_, source)| *source)
}

/// Source lines that are code, paired with their one-based line number. Doc
/// comments are excluded so a comment may name a banned call in order to
/// explain why it is banned.
fn code_lines(source: &str) -> impl Iterator<Item = (usize, &str)> {
    source
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("///") || trimmed.starts_with("//!"))
        })
        .map(|(index, line)| (index + 1, line))
}

fn line_instantiates_pattern(line: &str) -> bool {
    line.contains(concat!("get_", "pattern"))
}

fn allowlist_entry_still_live(source: &str) -> bool {
    code_lines(source).any(|(_, line)| line_instantiates_pattern(line))
}

fn pattern_ban_offences(name: &str, source: &str) -> Vec<(usize, String)> {
    let mut offences = Vec::new();
    if allowlisted(name) {
        return offences;
    }
    for (number, line) in code_lines(source) {
        if line_instantiates_pattern(line) {
            offences.push((number, line.to_string()));
        }
    }
    offences
}

/// Calls the occlusion gate must never make, over the sources most tempted to
/// make them.
///
/// `get_children` retires a subtree in one cross-process call, which is what
/// the walk's own bounded enumeration exists to replace. `UIAutomation::new(`
/// builds a second automation client where `automation_client()` already owns
/// the one this process shares. `add_pattern` moves a per-node
/// `QueryInterface` into the cache request, the cost the batched property
/// design is built to avoid.
///
/// `get_pattern` is that same `QueryInterface` paid inline, and stays banned
/// everywhere but the allowlisted `actions/` files: `ScrollItemPattern` exposes
/// no property-shaped equivalent, so its one invocation is the only way to ask
/// a provider to bring an item into view. A second call site anywhere —
/// `tree/` included — fails here.
#[test]
fn the_occlusion_gate_issues_no_banned_call() {
    let banned = [
        concat!("get_", "children"),
        concat!("UIAutomation", "::new("),
        concat!("add_", "pattern"),
    ];
    for (name, source) in scanned() {
        for (number, line) in code_lines(source) {
            for call in banned {
                assert!(
                    !line.contains(call),
                    "{name}:{number} must never call {call}: {line}"
                );
            }
        }
        if let Some((number, line)) = pattern_ban_offences(name, source).into_iter().next() {
            panic!("{name}:{number} instantiates a pattern; only PATTERN_ALLOWLIST may: {line}");
        }
    }
}

/// An allowlist outlives the reason for it unless something says otherwise.
/// If an entry's file stops needing a pattern handle, this fails and the
/// exception is deleted rather than left widening the ban for nothing.
#[test]
fn the_pattern_allowlist_covers_a_call_site_that_is_still_there() {
    let mut entries = 0usize;
    for entry in PATTERN_ALLOWLIST {
        entries += 1;
        let source = source_for_allowlist_entry(entry)
            .unwrap_or_else(|| panic!("{entry} is allowlisted but missing from GATE_SUPPORT"));
        assert!(
            allowlist_entry_still_live(source),
            "{entry} no longer instantiates a pattern, so its allowlist entry is dead"
        );
    }
    assert!(
        entries > 0,
        "PATTERN_ALLOWLIST must list every actions/ file that calls get_pattern"
    );
}

/// MUST-CATCH: a `get_pattern` line outside the allowlist is an offence the
/// shared scanner reports. The fixture and the real gate share
/// `pattern_ban_offences`, so a rule rewrite that stops catching off-list
/// call sites fails here rather than silently opening the ban.
#[test]
fn a_get_pattern_call_outside_the_allowlist_is_caught() {
    let fixture_name = "tree/hit_test/mod.rs";
    assert!(
        !allowlisted(fixture_name),
        "fixture host must stay off the allowlist"
    );
    let fixture = concat!("let _ = element.get_", "pattern::<UIScrollItemPattern>();");
    let offences = pattern_ban_offences(fixture_name, fixture);
    assert_eq!(
        offences.len(),
        1,
        "a live get_pattern line outside the allowlist must be caught"
    );
}

/// MUST-CATCH: an allowlist entry whose source no longer calls `get_pattern`
/// fails the live-call-site tripwire. Shares the same predicate the tripwire
/// uses, so a rewrite that stops requiring a live site fails here.
#[test]
fn a_dead_allowlist_entry_fails_the_live_call_site_tripwire() {
    let dead = "fn never_calls_patterns() { let _ = 1; }\n";
    assert!(
        !allowlist_entry_still_live(dead),
        "a source with no get_pattern must fail the shared live-call-site predicate"
    );
}

/// A2-5 measured UIA property ids as build-specific, so a bare integer is a
/// hand-written table that fails silently on a Windows whose ids differ. Every
/// property the gate reads travels through `TreeProperty`, which resolves
/// against the crate-generated constants instead.
#[test]
fn no_property_id_integer_appears_in_the_occlusion_gate() {
    for (name, source) in scanned() {
        for (number, line) in code_lines(source) {
            assert!(
                !contains_property_id_literal(line),
                "{name}:{number} carries a UIA property-id literal: {line}"
            );
        }
    }
}

/// The occluder's name is structured data here, never rendered text.
///
/// An occluder's name is provider-authored text read off a window the agent
/// did not target, and it leaves this crate once: as the `name` field of
/// `HitTestResult::InterceptedBy`, where the core contract governs whether it
/// is serialized and whether a secure field withholds it. A message, a
/// `platform_detail`, or a log line assembled in these three files would carry
/// the same text into a channel with no such governance - and the actionability
/// battery copies an error's `details` verbatim into a trace.
///
/// What this proves: the three files invoke no macro other than `matches!`, so
/// there is no `format!`, `write!`, `panic!` or `json!` in them to interpolate
/// anything at all, the name included. It reads the source text, so it covers
/// every line rather than the paths a test happens to drive.
///
/// What it does not prove: that the name never reaches a caller - it does, by
/// design, as structured evidence - nor that a `String` assembled by
/// concatenation rather than by a macro would be caught. Those remain with the
/// occluder-evidence tests, which assert on the value.
#[test]
fn the_hit_test_family_invokes_no_macro_that_can_render_the_occluder_name() {
    for (name, source) in HIT_TEST_FAMILY {
        for (number, line) in code_lines(source) {
            for invoked in macro_invocations(line) {
                assert!(
                    NON_RENDERING_MACROS.contains(&invoked),
                    "{name}:{number} invokes {invoked}!, which can render the occluder name: {line}"
                );
            }
        }
    }
}

/// Names of the macros a line invokes.
///
/// A `!` counts as an invocation only when an identifier runs up to it and an
/// `=` does not follow, so the `!=` operator and a leading `!` negation are not
/// mistaken for one.
fn macro_invocations(line: &str) -> Vec<&str> {
    let mut invoked = Vec::new();
    for (index, character) in line.char_indices() {
        if character != '!' || line[index + 1..].starts_with('=') {
            continue;
        }
        let start = line[..index]
            .char_indices()
            .rev()
            .take_while(|(_, character)| character.is_ascii_alphanumeric() || *character == '_')
            .map(|(position, _)| position)
            .last();
        if let Some(start) = start {
            invoked.push(&line[start..index]);
        }
    }
    invoked
}

/// Whether a line carries a bare integer in UIA's property-id range, by the
/// rule the property vocabulary applies to itself: a whole token, five digits,
/// between 30000 and 30999. A prose 300, or a 30_000 ms budget, is not a
/// property id and must not fail the scan.
fn contains_property_id_literal(line: &str) -> bool {
    line.split(|character: char| !(character.is_ascii_digit() || character == '_'))
        .filter(|token| !token.is_empty())
        .map(|token| token.replace('_', ""))
        .any(|token| {
            token.len() == 5
                && token
                    .parse::<u32>()
                    .is_ok_and(|value| (30_000..=30_999).contains(&value))
        })
}
