use agent_desktop_core::{
    Deadline, ErrorCode, InteractionLease, InteractionPolicy, SnapshotSurface,
};

use crate::system::SharedBus;
use crate::system::shell::kinds::advertised;

#[test]
fn an_absent_or_unreadable_tree_advertises_nothing() {
    for tree in [
        super::super::detect::Fact::Absent("x".to_owned()),
        super::super::detect::Fact::Unreadable("y".to_owned()),
    ] {
        assert!(advertised(&tree).is_empty());
    }
}

#[test]
fn taskbar_open_is_refused_before_any_bus_access() {
    let deadline = Deadline::after(1_000).expect("valid deadline");
    let lease = InteractionLease::guarded(deadline, ()).expect("valid lease");
    let error = crate::system::shell::open_surface(
        &SharedBus::default(),
        SnapshotSurface::Taskbar,
        InteractionPolicy::headless(),
        &lease,
    )
    .expect_err("the shell does not present a taskbar");
    assert_eq!(error.code, ErrorCode::PlatformNotSupported);
    assert!(error.message.contains("no stock shell shows a dock"));
}
