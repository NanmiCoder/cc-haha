use agent_desktop_core::{Action, ActionResult};

use super::live_bench::Toolkit;
use super::live_bench_iteration::each_toolkit;
use super::live_scroll_tests::read;

fn verified(result: &ActionResult) -> Vec<Option<bool>> {
    result.steps.iter().map(|step| step.verified).collect()
}

#[test]
#[ignore = "needs lane A's write engine; run through scripts/private-session.sh --wm"]
fn set_value_and_clear_land_on_a_text_field_in_every_toolkit() {
    each_toolkit(|toolkit, bench| {
        let field = bench.named("field");
        let result = bench
            .act(&field, Action::SetValue("hello".to_owned()))
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert_eq!(bench.text_of(&field), "hello", "{toolkit:?}");
        assert!(verified(&result).contains(&Some(true)), "{toolkit:?}");
        bench
            .act(&field, Action::Clear)
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert_eq!(bench.text_of(&field), "", "{toolkit:?}");
    });
}

#[test]
#[ignore = "needs lane A's write engine and lane B's caret read; run through scripts/private-session.sh --wm"]
fn type_inserts_non_ascii_text_into_an_empty_field_exactly() {
    each_toolkit(|toolkit, bench| {
        let field = bench.named("field");
        for piece in [
            "ab",
            "\u{e9}",
            "\u{1F600}",
            "e\u{301}",
            "ab\u{e9}\u{1F600}e\u{301}",
        ] {
            bench
                .act(&field, Action::SetValue(String::new()))
                .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
            bench
                .act(&field, Action::TypeText(piece.to_owned()))
                .unwrap_or_else(|error| panic!("{toolkit:?} {piece:?}: {error}"));
            assert_eq!(bench.text_of(&field), piece, "{toolkit:?} {piece:?}");
        }
    });
}

#[test]
#[ignore = "needs lane A's write engine and lane B's caret read; run through scripts/private-session.sh --wm"]
fn type_after_a_wide_character_lands_at_the_caret_exactly() {
    each_toolkit(|toolkit, bench| {
        let field = bench.named("field");
        let state = bench.fixture_file("state.json");
        let expected_caret = if matches!(toolkit, Toolkit::Qt) { 3 } else { 2 };
        assert!(
            bench
                .wait_for(|| {
                    let observed = read(&state);
                    (observed["text"] == "a😀z" && observed["caret"] == expected_caret)
                        .then_some(())
                })
                .is_some(),
            "fixture establishes an interior caret after the wide character"
        );
        bench
            .act(&field, Action::TypeText("\u{e9}".to_owned()))
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert_eq!(bench.text_of(&field), "a😀éz", "{toolkit:?}");
        assert_eq!(read(&state)["text"], "a😀éz", "fixture-side text");
    });
}

#[test]
#[ignore = "needs lane A's write engine; run through scripts/private-session.sh --wm"]
fn a_password_field_write_lands_and_the_result_never_carries_the_text() {
    const SECRET: &str = "zx-secret-7731";
    each_toolkit(|toolkit, bench| {
        let secret = bench.named("secret");
        let state = bench.fixture_file("state.json");
        assert_eq!(read(&state)["secret_length"], 0);
        let outcome = bench.act(&secret, Action::SetValue(SECRET.to_owned()));
        let rendered = match &outcome {
            Ok(result) => serde_json::to_string(result).expect("a result serializes"),
            Err(error) => format!("{error:?}"),
        };
        assert!(!rendered.contains(SECRET), "{toolkit:?}: {rendered}");
        let result = outcome.expect("the fixture supports secure text writes");
        assert!(
            bench
                .wait_for(|| (read(&state)["secret_matches"] == true).then_some(()))
                .is_some(),
            "fixture must observe the write"
        );
        assert!(!verified(&result).contains(&Some(true)), "{toolkit:?}");
    });
}
