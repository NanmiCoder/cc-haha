use super::*;

#[test]
fn an_open_overview_is_the_cause_when_nothing_was_granted() {
    let mut world = World::new(None);
    world.grant = Grant::Never;
    world.overview = Some(true);
    let error = failure(&world);
    assert_refused(&error, "overview_open");
    assert_eq!(world.sends(), 0, "the refusal is decided before activation");
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|text| text.contains("Escape"))
    );
}

#[test]
fn a_closed_or_unreadable_overview_leaves_the_cause_unclaimed() {
    for overview in [Some(false), None] {
        let mut world = World::new(None);
        world.grant = Grant::Never;
        world.overview = overview;
        assert_refused(&failure(&world), "activation_not_granted");
    }
}

#[test]
fn a_frame_that_does_not_report_active_stays_unclaimed_without_an_open_overview() {
    for overview in [Some(false), None] {
        let mut world = World::new(None);
        world.grant = Grant::OnlyOnX11;
        world.overview = overview;
        assert_refused(&failure(&world), "frame_not_active");
    }
}
