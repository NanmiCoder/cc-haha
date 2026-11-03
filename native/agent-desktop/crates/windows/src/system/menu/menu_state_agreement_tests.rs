//! Whether the menu detector and the menu locator answer the same question.
//!
//! Split from `menu_state_tests.rs` so that file stays inside the size cap.
//! These cases are about the agreement between two predicates rather than
//! about either one on its own.

use super::*;

use crate::system::menu::menu_state::locate::first_located;

/// The composition every source after the first is reached through, driven
/// directly.
///
/// This is the executable half of the guarantee the structural cases below
/// can only read off the source text. The defect it inverts against is the
/// shipped one: `locate_menu` returned early when the tool-window pool was
/// empty, so the Chromium source was never consulted for a process whose
/// menu lives in its own window - a `surface-appeared` wait fired and the
/// `snapshot --surface menu` after it answered `WINDOW_NOT_FOUND`.
///
/// A live positive for that path - a real Chromium DOM menu located end to
/// end - is not staged anywhere in this suite: the rig has no Chromium shell
/// the e2e scenario could open a menu in. What is covered here is the
/// composition itself, on values, which is the part that regressed.
#[test]
fn a_source_that_locates_nothing_still_consults_the_next_one() {
    let located = first_located(None, || Ok(Some(7u32)));

    assert_eq!(
        located.expect("a fall-through that locates something is not a failure"),
        Some(7),
        "a source answering None must fall through, not end the search"
    );
}

/// The other direction: a source that did locate something answers, and the
/// next source is never paid for. The fall-through added for the Chromium
/// case must not turn every located tool-window menu into a second search.
#[test]
fn a_source_that_locates_something_does_not_pay_for_the_next_one() {
    let located = first_located(Some(1u32), || -> Result<Option<u32>, AdapterError> {
        panic!("the next source must not be consulted once one has located a menu")
    });

    assert_eq!(
        located.expect("the located menu is the answer"),
        Some(1),
        "the first source to locate a menu answers"
    );
}

/// A refusal from the next source reaches the caller. Flattening it to `None`
/// would turn a budget exhaustion into "no menu is open", which is the false
/// negative the whole surface arm exists to avoid.
#[test]
fn a_refusal_from_the_next_source_is_propagated_rather_than_read_as_no_menu() {
    let located: Result<Option<u32>, AdapterError> = first_located(None, || {
        Err(AdapterError::new(
            ErrorCode::Timeout,
            "the next source ran out of budget",
        ))
    });

    assert_eq!(
        located
            .expect_err("a refused fall-through must not read as an absent menu")
            .code,
        ErrorCode::Timeout
    );
}

/// The defect this guards is a source set that drifts. `menu_is_open` composes
/// three sources; `locate_menu` implemented only one, so a wait that fired on
/// the Chromium source was followed by a snapshot that answered
/// `WINDOW_NOT_FOUND`. Adding a fourth source to the detector without giving
/// the locator a way to root it would reopen exactly that gap, and a live test
/// cannot see it: it needs the application that fires the new source.
///
/// The source set is read from the calls inside `menu_is_open`'s own body
/// rather than from the file, so a source that is only mentioned in a doc
/// comment is not counted, and an unmapped fourth source fails the match arm
/// below instead of passing unnoticed.
///
/// The bound on that: what is read is the calls taking exactly
/// `(pid, deadline)`, which is the shape every source has and no guard in
/// that body has. A fourth source introduced with a different argument list
/// is outside what this reads, and this case would not see it.
///
/// What each arm checks differs by what is checkable. The two locatable
/// sources are matched to the locator function that resolves them. The
/// classic source is matched only to its being *named* in the locator's
/// documentation, because "named as not locatable" is the entire claim for
/// that one - this case does not, and cannot, check that it resolves.
#[test]
fn every_detector_source_is_either_locatable_or_named_as_not() {
    let detector = include_str!("menu_state.rs");
    let locator = include_str!("menu_state_locate.rs");

    let detector_body = body_of(detector, "pub(crate) fn menu_is_open(");
    let sources = sources_called_by(&detector_body);
    for expected in [
        "classic_menu_mode_active",
        "uia_menu_reachable",
        "chromium_dom_menu_reachable",
    ] {
        assert!(
            sources.contains(&expected),
            "{expected} is no longer called by the detector - the mapping below describes a \
             source set that no longer exists and must be revisited"
        );
    }

    for source in sources {
        match source {
            "classic_menu_mode_active" => assert!(
                locator.contains("classic_menu_mode_active"),
                "the one source the locator cannot resolve is named in its own documentation, \
                 so the divergence is stated rather than discovered"
            ),
            "uia_menu_reachable" => assert!(
                body_of(locator, "fn locate_in_tool_windows(")
                    .contains("probe_candidate_element(&client, &condition, handle)"),
                "the tool-window source has a locating shape"
            ),
            "chromium_dom_menu_reachable" => assert!(
                body_of(locator, "fn locate_chromium(")
                    .contains("locate_chromium_dom_menu(pid, deadline)"),
                "the Chromium fall-through actually calls the Chromium locator"
            ),
            unmapped => panic!(
                "{unmapped} is a detector source with no locator mapping: give it a locating \
                 shape, or state in the locator's documentation that it cannot have one"
            ),
        }
    }
}

/// The locator must reach every locatable source unconditionally. The shipped
/// defect was an early `Ok(None)` in `locate_menu` on an empty tool-window
/// pool, which skipped the Chromium source for every process whose menu is
/// not in a tool window; the composition is now the only thing in that body,
/// so there is no return for a source's empty pool to take.
///
/// The Windows definition is sliced by its `cfg` attribute as well as its
/// signature: the non-Windows stub below it answers `Ok(None)` legitimately,
/// and matching the bare signature could slice that one instead.
#[test]
fn locate_menu_composes_its_sources_instead_of_returning_early() {
    let locator = include_str!("menu_state_locate.rs");
    let locate_menu_body = body_of(
        locator,
        "#[cfg(target_os = \"windows\")]\npub(crate) fn locate_menu(",
    );

    assert!(
        locate_menu_body.contains("first_located("),
        "locate_menu reaches its later sources through the composition the tests above drive"
    );
    assert!(
        locate_menu_body.contains("locate_in_tool_windows(pid, deadline)"),
        "locate_menu asks the tool-window source"
    );
    assert!(
        locate_menu_body.contains("locate_chromium(pid, deadline)"),
        "locate_menu must reach the Chromium source, or a wait that fires on it is followed \
         by a snapshot that cannot root what the wait found"
    );
    assert!(
        !locate_menu_body.contains("Ok(None)"),
        "locate_menu must own no absent answer of its own: an early return here is what made \
         the Chromium source unreachable"
    );
}

/// The identifiers called with `(pid, deadline)` inside one function body.
/// In the detector's body only its sources take that argument pair - the
/// budget and existence guards take one argument each - so this is the set of
/// sources actually called, as opposed to mentioned.
fn sources_called_by(body: &str) -> Vec<&str> {
    body.match_indices("(pid, deadline)")
        .map(|(offset, _)| {
            let before = &body[..offset];
            let start = before
                .rfind(|character: char| !character.is_alphanumeric() && character != '_')
                .map_or(0, |index| index + 1);
            &before[start..]
        })
        .collect()
}

/// The text of one function, from its signature to the first line that closes
/// it at column zero. Enough to tell a call inside a body from a mention
/// elsewhere in the file, which is the distinction the tests above need.
///
/// Carriage returns are stripped first. The source arrives through
/// `include_str!`, so it carries whatever the checkout has — LF where this
/// was written, CRLF on a Windows CI checkout — and a signature spanning a
/// line, or a closing brace matched as `\n}`, finds neither reliably.
/// Skipping this passed here and failed both Windows lanes, on a test whose
/// subject has nothing to do with line endings.
fn body_of(source: &str, signature: &str) -> String {
    let source: String = source
        .chars()
        .filter(|character| *character != '\r')
        .collect();
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("{signature} still exists"));
    let rest = &source[start..];
    let end = rest.find("\n}").map_or(rest.len(), |offset| offset + 2);
    rest[..end].to_owned()
}

/// At rest the two predicates agree, in both directions, against a real
/// fixture: nothing is open and nothing can be rooted. This is the live half -
/// it cannot exercise the Chromium source, which needs a Chromium application,
/// but it does prove the locator's new fall-through did not make it answer
/// `Some` for a process with no menu at all.
#[test]
fn at_rest_the_detector_and_the_locator_agree_that_no_menu_is_open() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let pid = ProcessId::from(fixture.process_id());

    assert!(!menu_is_open(pid, deadline(10_000)).expect("the detector reads the fixture"));
    assert!(
        crate::system::menu::menu_state::locate_menu(pid, deadline(10_000))
            .expect("the locator reads the fixture")
            .is_none(),
        "with no menu open the locator must answer None rather than rooting something else"
    );
}

/// The other direction for the tool-window source, which this fixture can
/// stage: an open menu is both detected and locatable, so the pair agrees
/// where the documentation says it must.
#[test]
fn an_open_tool_window_menu_is_both_detected_and_locatable() {
    bootstrap();
    let _app_name_scope = FIXTURE_APP_NAME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _stage = crate::tree::fixture::fixture_window::on_screen_stage();
    let fixture = MenuFixture::spawn().expect("the menu fixture starts");
    let pid = ProcessId::from(fixture.process_id());

    fixture.open_context_menu();
    assert!(fixture.wait_for_menu_state(true, STATE_TIMEOUT));
    assert!(settles_to(STATE_TIMEOUT, true, || menu_is_open(
        pid,
        deadline(10_000)
    )
    .expect("the detector reads the fixture")));

    assert!(
        settles_to(STATE_TIMEOUT, true, || {
            crate::system::menu::menu_state::locate_menu(pid, deadline(10_000))
                .expect("the locator reads the fixture")
                .is_some()
        }),
        "a menu the detector reports open must be one the surface can root"
    );

    fixture.dismiss_context_menu();
    assert!(fixture.wait_for_menu_state(false, STATE_TIMEOUT));
}

/// A pid that names no running process surfaces a classified `AppUnresponsive`,
/// never a panic and never a silent "closed". Pid 1 is not a valid Windows
/// process id, so the case is deterministic and needs no spawned-and-killed
/// process, which could be raced by pid reuse.
#[test]
fn a_nonexistent_pid_returns_a_classified_error_not_a_panic_or_false_closed() {
    let pid = ProcessId::from(1u32);

    let error = menu_is_open(pid, deadline(10_000))
        .expect_err("a nonexistent pid must not silently report closed");

    assert_eq!(error.code, ErrorCode::AppUnresponsive);
}
