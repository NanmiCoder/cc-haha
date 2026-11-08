use crate::cli_args::cursor_overlay_enable::CursorOverlayEnableArgs;
use clap::Parser;

#[derive(Parser)]
struct Harness {
    #[command(flatten)]
    enable: CursorOverlayEnableArgs,
}

fn parse(args: &[&str]) -> Result<Harness, clap::Error> {
    Harness::try_parse_from(std::iter::once("enable").chain(args.iter().copied()))
}

#[test]
fn motion_flags_build_the_core_profile() {
    let harness = parse(&[
        "--travel-ms",
        "200,500",
        "--bow",
        "1.6",
        "--overshoot",
        "0.06",
        "--tremor",
        "2",
        "--dwell-ms",
        "100",
        "--motion-seed",
        "7",
    ])
    .unwrap();
    let config = harness.enable.to_core().unwrap();
    let motion = config.motion();
    assert_eq!(motion.travel_ms(), (200, 500));
    assert_eq!(motion.bow(), 1.6);
    assert_eq!(motion.overshoot(), 0.06);
    assert_eq!(motion.tremor(), 2.0);
    assert_eq!(motion.dwell_ms(), 100);
    assert_eq!(motion.seed(), Some(7));
}

#[test]
fn omitted_motion_flags_keep_the_default_profile() {
    let config = parse(&["--dwell-ms", "40"])
        .unwrap()
        .enable
        .to_core()
        .unwrap();
    let mut expected = agent_desktop_core::CursorMotionProfile::default();
    expected.set_dwell_ms(40);
    assert_eq!(config.motion(), &expected);
    let config = parse(&[]).unwrap().enable.to_core().unwrap();
    assert!(config.motion().is_default());
}

#[test]
fn malformed_travel_ranges_are_parse_errors() {
    for value in [
        "200",
        "200,",
        ",500",
        "a,b",
        "200;500",
        "-1,300",
        "200,500,700",
    ] {
        let error = parse(&["--travel-ms", value]).err().expect(value);
        assert_eq!(error.exit_code(), 2, "{value}");
    }
    assert_eq!(
        parse(&["--dwell-ms", "-5"]).err().map(|e| e.exit_code()),
        Some(2)
    );
}

#[test]
fn out_of_budget_motion_is_invalid_args() {
    let error = parse(&["--travel-ms", "300,600", "--dwell-ms", "150"])
        .unwrap()
        .enable
        .to_core()
        .expect_err("travel plus dwell exceeds the budget");
    assert_eq!(error.code(), "INVALID_ARGS");
    assert!(error.to_string().contains("700 ms"));
    let error = parse(&["--bow", "5"])
        .unwrap()
        .enable
        .to_core()
        .unwrap_err();
    assert_eq!(error.code(), "INVALID_ARGS");
}
