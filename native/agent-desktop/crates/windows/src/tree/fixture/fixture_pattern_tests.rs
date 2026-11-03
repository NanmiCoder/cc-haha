use super::*;

#[test]
#[ignore = "runs only in the re-executed pattern fixture host process"]
fn pattern_fixture_host_process_entry() {
    assert!(
        is_pattern_host_process(),
        "the pattern host entry must not run without the host flag"
    );
    run_as_pattern_host();
}

#[test]
fn independent_gdi_blit_yields_expected_quadrant_colours() {
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let samples = fixture
        .blit_client_samples()
        .expect("GDI blit samples the client area");
    assert!(
        fixture.expectation().matches_samples(&samples),
        "blit samples {samples:?} must match {:?}",
        fixture.expectation().sample_points()
    );
}

#[test]
fn wm_printclient_and_wm_paint_produce_the_same_pixels() {
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let paint = fixture
        .blit_client_samples()
        .expect("WM_PAINT path samples");
    let printed = fixture
        .printclient_samples()
        .expect("WM_PRINTCLIENT path samples");
    assert_eq!(
        paint, printed,
        "WM_PAINT and WM_PRINTCLIENT must share the paint routine"
    );
}

#[test]
fn mutating_one_quadrant_expectation_makes_the_assertion_fail() {
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let samples = fixture
        .blit_client_samples()
        .expect("GDI blit samples the client area");
    let mut wrong = fixture.expectation();
    wrong.colors.top_left = [0x01, 0x02, 0x03];
    assert!(
        !wrong.matches_samples(&samples),
        "a mutated expectation must fail against the real pattern"
    );
    assert!(fixture.expectation().matches_samples(&samples));
}

#[test]
fn pattern_fixture_cleans_up_window_and_class_on_drop() {
    let fixture = LocalPatternFixture::create().expect("pattern fixture starts");
    let handle = fixture.handle();
    let class_name = fixture.class_name().to_owned();
    assert!(window_still_exists(handle));
    assert!(class_still_registered(&class_name));
    drop(fixture);
    assert!(
        !window_still_exists(handle),
        "the pattern window must be gone after drop"
    );
    assert!(
        !class_still_registered(&class_name),
        "the pattern class must be unregistered after drop"
    );
}

#[test]
fn hosted_pattern_fixture_runs_in_a_second_process() {
    let fixture = HostedPatternFixture::spawn().expect("hosted pattern fixture starts");
    assert_ne!(fixture.process_id(), std::process::id());
    assert_ne!(fixture.handle(), 0);
}
