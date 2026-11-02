use agent_desktop_core::{BoundsSpace, ErrorCode, ObservationOps};

use super::live_fixture;
use super::live_rig::{deadline, rig};
use super::qt_live_tests::oracle_bounds;

#[test]
#[ignore = "real GTK4 geometry; run through scripts/private-session.sh --wm"]
fn gtk4_twins_resolve_only_in_the_refs_recorded_coordinate_frame() {
    let mut rig = rig();
    let fixture = live_fixture::gtk4(&mut rig.launched).expect("GTK4 starts");
    let settled = rig.settled(fixture.pid, 8);
    let twins = rig.named(&settled.frame, true, "Twin");
    assert_eq!(twins.len(), 2);
    for mut entry in twins {
        let original = rig
            .resolve(&entry)
            .expect("window-relative identity resolves");
        let width = oracle_bounds(&original)[2];
        let bounds = rig
            .adapter
            .get_element_bounds(&original, deadline(5000))
            .unwrap()
            .unwrap();
        entry.scope.path.clear();
        entry.identity.native_id = None;
        entry.identity.retained_object = None;
        entry.geometry.bounds = Some(bounds);
        entry.geometry.bounds_space = Some(BoundsSpace::Screen);
        entry.geometry.bounds_hash = bounds.bounds_hash();
        let resolved = rig
            .resolve(&entry)
            .expect("screen evidence is compared in screen coordinates");
        assert_eq!(
            oracle_bounds(&resolved)[2],
            width,
            "independent AT-SPI width identifies the twin"
        );
        entry.geometry.bounds.as_mut().unwrap().x += 500.0;
        let error = super::live_rig::refused(
            rig.resolve(&entry),
            "a moved screen rectangle separates neither twin",
        );
        assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    }
}
