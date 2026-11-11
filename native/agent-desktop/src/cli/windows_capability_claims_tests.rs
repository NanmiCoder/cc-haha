use super::*;

const WINDOWS_SKILL_DOC: &str = include_str!("../../skills/agent-desktop-windows/SKILL.md");

/// The whole Windows skill package. Behaviour notes may live in any of its
/// references; only the capability table is required to stay in SKILL.md.
const WINDOWS_SKILL_PACKAGE: &str = concat!(
    include_str!("../../skills/agent-desktop-windows/SKILL.md"),
    include_str!("../../skills/agent-desktop-windows/references/shell-and-overlay.md"),
    include_str!("../../skills/agent-desktop-windows/references/permissions-and-elevation.md"),
    include_str!("../../skills/agent-desktop-windows/references/chromium-and-electron.md"),
    include_str!("../../skills/agent-desktop-windows/references/troubleshooting.md"),
);

/// Commands the Windows table documents as unavailable that no adapter method
/// backs: core refuses them on every platform before dispatch reaches an
/// adapter, so the behavioural pin cannot cover them and must not pretend to.
/// They are listed rather than ignored so the closure assertion below stays
/// exhaustive.
const REFUSED_BY_CORE_ON_EVERY_PLATFORM: &[&str] =
    &["key-down", "key-up", "mouse-down", "mouse-up"];

/// Set assertion enforces that new unavailable commands are explicitly listed:
/// per-name checks alone miss rows that satisfy old assertions while never being verified.
#[test]
fn windows_skill_capability_claims_resolve_against_dispatch() {
    let dispatchable: BTreeSet<String> = cli_command_names().into_iter().collect();
    let working = windows_skill_commands(true);
    let unavailable = windows_skill_commands(false);

    assert!(
        !working.is_empty(),
        "the Windows capability table must claim working commands"
    );
    for name in working.iter().chain(unavailable.iter()) {
        assert!(
            dispatchable.contains(name),
            "the Windows skill claims '{name}' but dispatch has no such command"
        );
    }

    let documented: BTreeSet<&str> = unavailable.iter().map(String::as_str).collect();
    let accounted: BTreeSet<&str> = REFUSED_BY_CORE_ON_EVERY_PLATFORM.iter().copied().collect();
    assert_eq!(
        documented, accounted,
        "every command the Windows table documents as unavailable must be declared in \
         REFUSED_BY_CORE_ON_EVERY_PLATFORM; an unaccounted row is never verified"
    );
}

fn windows_skill_commands(claimed_working: bool) -> Vec<String> {
    let mut names = Vec::new();
    for row in WINDOWS_SKILL_DOC.lines() {
        if !row.trim_start().starts_with('|') || row.contains("---") {
            continue;
        }
        let cells: Vec<&str> = row.split('|').collect();
        if cells.len() < 4 || (cells[3].contains("Works")) != claimed_working {
            continue;
        }
        names.extend(
            cells[2]
                .split('`')
                .enumerate()
                .filter(|(index, _)| index % 2 == 1)
                .map(|(_, token)| token.trim().to_owned())
                .filter(|token| !token.is_empty()),
        );
    }
    names
}

#[test]
#[cfg(target_os = "windows")]
fn windows_adapter_still_refuses_what_the_skill_marks_unavailable() {
    use agent_desktop_core::{
        CursorOverlayControl, Deadline, ErrorCode, InteractionLease, InteractionPolicy,
        SnapshotSurface, SystemOps,
    };

    let adapter = agent_desktop_windows::WindowsAdapter::new();
    let deadline = Deadline::after(5_000).expect("bounded deadline");
    let lease = InteractionLease::guarded(deadline, ()).expect("lease");

    let quick_settings = SystemOps::open_system_surface(
        &adapter,
        SnapshotSurface::QuickSettings,
        InteractionPolicy::headed(),
        &lease,
    )
    .expect_err(
        "quick-settings must refuse on a build whose shell carries the \
         quick actions inside the Action Center",
    );
    assert_eq!(
        quick_settings.code,
        ErrorCode::PlatformNotSupported,
        "quick-settings changed behaviour; update the Windows skill's capability table"
    );
    let detail = quick_settings.platform_detail.expect(
        "the quick-settings refusal must carry the platform detail naming \
         the build and the surface that holds the capability",
    );
    assert!(
        detail.contains("action-center"),
        "the refusal must name 'action-center' as the surface carrying the \
         capability, got: {detail}"
    );

    SystemOps::update_cursor_overlay(
        &adapter,
        &CursorOverlayControl::disable("skill-capability-probe".into()),
    )
    .expect(
        "cursor-overlay renders on Windows now, and a disable against a session with no \
         renderer running succeeds without starting one - spawning there would begin a \
         renderer in order to tell it to stop. The skill's capability table moves with \
         this, in the same change.",
    );
}

/// The bullet a caller reads before sizing a `wait --notification` timeout.
/// Matched on the command rather than on a heading so the guard survives the
/// paragraph moving.
const POLL_COST_ANCHOR: &str = "`wait --notification` opens and closes the center per poll";

/// A ratified poll cost is only useful if the number that justifies it ships
/// beside it. Without this the paragraph could be reduced to "polling is slow"
/// and still read as documentation while telling a caller nothing it can size
/// a timeout against.
#[test]
fn the_wait_notification_bullet_carries_its_measured_per_poll_cost() {
    let start = WINDOWS_SKILL_PACKAGE.find(POLL_COST_ANCHOR).expect(
        "the Windows skill must document the per-poll session behaviour of wait --notification",
    );
    let bullet_end = WINDOWS_SKILL_PACKAGE[start..]
        .find("\n- ")
        .map_or(WINDOWS_SKILL_PACKAGE.len(), |offset| start + offset);
    let bullet = &WINDOWS_SKILL_PACKAGE[start..bullet_end];

    let states_a_decimal = bullet.split_whitespace().any(|token| {
        token.split_once('.').is_some_and(|(whole, fraction)| {
            whole
                .chars()
                .next_back()
                .is_some_and(|character| character.is_ascii_digit())
                && fraction
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_digit())
        })
    });
    assert!(
        states_a_decimal,
        "the wait --notification bullet must state a numeric per-poll cost; \
         a caller cannot size a timeout against prose alone. Bullet read: {bullet}"
    );
    assert!(
        bullet.contains("ms per poll") || bullet.contains("seconds per poll"),
        "the numeric cost must name its unit and that it is per poll. Bullet read: {bullet}"
    );
}

/// The first thing a Windows caller hits, and the one a POSIX-shaped example
/// cannot warn them about. PowerShell is the default shell there and deletes a
/// bare `@token` before the binary sees it, so a skill that omits this teaches
/// a form guaranteed to fail on the platform it documents.
#[test]
fn the_windows_skill_warns_that_powershell_eats_an_unquoted_ref() {
    assert!(
        WINDOWS_SKILL_PACKAGE.contains("splatting"),
        "the skill must name PowerShell's splatting operator as the reason a bare ref vanishes"
    );
    let quoted_example = WINDOWS_SKILL_PACKAGE.contains("'@s8f3k2p9:e1'");
    assert!(
        quoted_example,
        "the warning must show the quoted form, not merely assert that quoting is needed"
    );
}

/// Pins the verification vocabulary an agent has to branch on. The emitting
/// side is core's own `post_action` tests; what this guards is the doc, because
/// a skill that omits `unavailable` teaches an agent to read missing evidence
/// as a failed change - the one reading that turns a working action into an
/// abandoned one.
#[test]
fn the_windows_skill_teaches_the_verification_outcomes_an_agent_branches_on() {
    for token in [
        "element_value",
        "unavailable",
        "post_action_verification",
        "delivered_verified",
    ] {
        assert!(
            WINDOWS_SKILL_PACKAGE.contains(token),
            "the skill must name {token} so an agent can tell the outcomes apart"
        );
    }
}

/// The role-scoped numeric tolerance decides which controls survive a value the
/// application reformats. The skill lists those roles by name, so the list must
/// be the one `value_matches` applies rather than a remembered copy of it.
#[test]
fn the_windows_skill_lists_the_roles_that_compare_numerically() {
    for role in ["slider", "incrementor", "scrollbar", "handle"] {
        assert!(
            WINDOWS_SKILL_PACKAGE.contains(role),
            "the skill must name {role} as numerically compared"
        );
        assert!(
            agent_desktop_core::value_matches(role, "42", Some("42.0")),
            "{role} must still compare numerically for the skill's claim to hold"
        );
    }
    assert!(
        !agent_desktop_core::value_matches("textfield", "42", Some("42.0")),
        "the skill's textfield counter-example must still fail an exact comparison"
    );
}
