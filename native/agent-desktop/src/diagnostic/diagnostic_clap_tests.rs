use super::clap_error_summary;

/// The shape clap emits for a missing positional: the headline carries no
/// argument name, so a summary built from it alone cannot say what is missing.
const MISSING_POSITIONAL: &str = "error: the following required arguments were not provided:\n  <VALUE>\n\nUsage: agent-desktop.exe set-value <REF> <VALUE>\n\nFor more information, try '--help'.";

#[test]
fn a_missing_argument_summary_names_the_argument() {
    let summary = clap_error_summary(MISSING_POSITIONAL);

    assert!(
        summary.contains("<VALUE>"),
        "the caller cannot act on a message that omits the missing argument, got: {summary}"
    );
    assert!(
        !summary.contains("Usage:"),
        "usage boilerplate is not actionable for a machine consumer, got: {summary}"
    );
    assert!(
        !summary.contains('\n'),
        "the envelope carries a single-line message, got: {summary}"
    );
}

#[test]
fn a_single_line_error_is_unchanged_and_an_empty_one_still_says_something() {
    assert_eq!(
        clap_error_summary("error: unexpected argument '--nope' found"),
        "error: unexpected argument '--nope' found"
    );
    assert_eq!(clap_error_summary(""), "parse error");
    assert_eq!(clap_error_summary("\n\nUsage: x"), "parse error");
}
