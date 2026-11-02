use agent_desktop_core::{Action, DeliverySemantics};

use super::live_bench::Toolkit;
use super::live_bench_iteration::each_toolkit;

const SCROLL_BAR: u32 = 48;

#[test]
#[ignore = "needs lane A's write engine; run through scripts/private-session.sh --wm"]
fn spin_writes_follow_toolkit_readback_instead_of_the_step_increment() {
    each_toolkit(|toolkit, bench| {
        let spin = bench.named("spin");
        bench
            .act(&spin, Action::SetValue("7".to_owned()))
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert_eq!(bench.number_of(&spin), 7.0, "{toolkit:?}");
        let fraction = bench.act(&spin, Action::SetValue("7.5".to_owned()));
        if matches!(toolkit, Toolkit::Qt) {
            let rounded = fraction.expect("integer widget rounds the write");
            assert_eq!(
                rounded.disposition(),
                DeliverySemantics::delivered_unverified()
            );
            assert_eq!(bench.number_of(&spin), 8.0, "{toolkit:?}");
        } else {
            let result = fraction.expect("step increment does not forbid fractions");
            assert_eq!(bench.number_of(&spin), 7.5, "{toolkit:?}");
            if matches!(toolkit, Toolkit::Gtk4) {
                assert!(result.steps.iter().all(|step| step.verified != Some(true)));
            }
        }
    });
}

#[test]
#[ignore = "needs lane A's write engine; run through scripts/private-session.sh --wm"]
fn a_slider_is_clamped_and_the_stored_value_is_not_reported_as_verified() {
    each_toolkit(|toolkit, bench| {
        let scale = bench.named("scale");
        let result = bench
            .act(&scale, Action::SetValue("500".to_owned()))
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert_eq!(bench.number_of(&scale), 100.0, "{toolkit:?}");
        let proved = result.steps.iter().any(|step| step.verified == Some(true));
        assert!(!proved, "{toolkit:?}: a clamped write must not verify");
        bench
            .act(&scale, Action::SetValue("0.2".to_owned()))
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        assert!(bench.number_of(&scale) <= 1.0, "{toolkit:?}");
    });
}

#[test]
#[ignore = "needs lane A's write engine; run through scripts/private-session.sh --wm"]
fn a_scroll_bar_write_moves_the_content() {
    each_toolkit(|toolkit, bench| {
        let bar = bench
            .all_with_role(SCROLL_BAR)
            .into_iter()
            .find(|bar| bench.maximum_of(bar) > 0.0)
            .unwrap_or_else(|| {
                panic!("{toolkit:?}: fixture must expose a positive-range scrollbar")
            });
        let before = bench.number_of(&bar);
        let advertised = bench.maximum_of(&bar);
        bench
            .act(&bar, Action::SetValue(advertised.to_string()))
            .unwrap_or_else(|error| panic!("{toolkit:?}: {error}"));
        let after = bench.number_of(&bar);
        assert!(
            after > before,
            "{toolkit:?}: {before} -> {after} (advertised {advertised})"
        );
    });
}
