use std::time::Duration;

use agent_desktop_core::{ErrorCode, NativeHandle, RefEntry};
use zbus::blocking::Connection;

use super::live_fixture;
use super::live_rig::{Rig, deadline, refused, rig, wait_until};
use super::live_tree::{children_of, pid_of};
use crate::system::{REGISTRY_ROOT_PATH, REGISTRY_SERVICE};

pub(in crate::tree) fn oracle_bounds(handle: &NativeHandle) -> [i32; 4] {
    let element = crate::tree::atspi_element(handle).expect("Linux handle");
    let output = std::process::Command::new("python3")
        .args([
            "-c",
            r#"
import json, sys
from gi.repository import Gio, GLib
session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync('org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Bus',
    'GetAddress', None, None, Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
bus = Gio.DBusConnection.new_for_address_sync(address, flags, None, None)
bounds = bus.call_sync(sys.argv[1], sys.argv[2], 'org.a11y.atspi.Component',
    'GetExtents', GLib.Variant('(u)', (0,)), None, Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]
print(json.dumps(bounds))
"#,
            element.bus_name(),
            element.path(),
        ])
        .output()
        .expect("independent AT-SPI oracle starts");
    assert!(output.status.success(), "{output:?}");
    serde_json::from_slice(&output.stdout).expect("oracle rectangle")
}

fn widths(rig: &Rig, entries: &[RefEntry]) -> Vec<f64> {
    entries
        .iter()
        .map(|entry| {
            let handle = rig.resolve(entry).expect("the twin resolves");
            f64::from(oracle_bounds(&handle)[2])
        })
        .collect()
}

fn bus_names_of(connection: &Connection, pid: u32) -> Vec<String> {
    children_of(connection, REGISTRY_SERVICE, REGISTRY_ROOT_PATH)
        .into_iter()
        .filter(|(bus, _)| pid_of(connection, bus) == Some(pid))
        .map(|(bus, _)| bus)
        .collect()
}

fn path_emptied(entries: &[RefEntry]) -> Vec<RefEntry> {
    entries.iter().map(super::live_rig::search_entry).collect()
}

fn object_identity_cleared(entries: &[RefEntry]) -> Vec<RefEntry> {
    entries
        .iter()
        .cloned()
        .map(|mut entry| {
            entry.identity.retained_object = None;
            entry.identity.native_id = None;
            entry
        })
        .collect()
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn qt_live_moved_screen_twins_refuse_old_geometry_and_fresh_refs_stay_distinct() {
    let mut rig = rig();
    let fixture = live_fixture::qt(&mut rig.launched).expect("the fixture starts");
    let settled = rig.settled(fixture.pid, 8);
    let twins = rig.named(&settled.frame, true, "Twin");
    assert_eq!(twins.len(), 2);
    let stored: Vec<f64> = twins
        .iter()
        .map(|entry| entry.geometry.bounds.expect("a rectangle").width)
        .collect();
    let handle = rig.resolve(&twins[0]).expect("resolves before the move");
    let before = oracle_bounds(&handle);

    fixture.send("move 420 260");
    assert!(
        wait_until(Duration::from_secs(8), || oracle_bounds(&handle)[..2]
            != before[..2]),
        "the window moved"
    );
    let after = oracle_bounds(&handle);
    println!(
        "qt_live move: ({}, {}) -> ({}, {})",
        before[0], before[1], after[0], after[1]
    );

    for entry in &twins {
        assert_eq!(
            refused(rig.resolve(entry), "screen position changed").code,
            ErrorCode::AmbiguousTarget
        );
    }
    let fresh = rig.named(&settled.frame, true, "Twin");
    assert_eq!(
        widths(&rig, &fresh),
        stored,
        "fresh geometry separates twins"
    );
    let mut nothing = object_identity_cleared(&path_emptied(&fresh));
    assert_eq!(
        widths(&rig, &nothing),
        stored,
        "whole recorded screen rectangle"
    );
    for entry in &mut nothing {
        entry.geometry.bounds = None;
        entry.geometry.bounds_hash = None;
    }
    let error = refused(rig.resolve(&nothing[0]), "nothing separates the twins");
    assert_eq!(error.code, ErrorCode::AmbiguousTarget);
    assert_eq!(
        error.details.as_ref().expect("details")["candidate_count"],
        2
    );
    assert!(!error.is_explicitly_retryable());
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn qt_live_a_process_with_two_bus_connections_resolves_through_the_window_owning_one() {
    let mut rig = rig();
    let fixture = live_fixture::qt(&mut rig.launched).expect("the fixture starts");
    let settled = rig.settled(fixture.pid, 8);
    let connection = rig.bus.get(deadline(5_000)).expect("the bus");
    assert!(
        wait_until(Duration::from_secs(8), || {
            bus_names_of(&connection, fixture.pid).len() == 2
        }),
        "a Qt process registers two bus connections: {:?}",
        bus_names_of(&connection, fixture.pid)
    );
    let owners = bus_names_of(&connection, fixture.pid);
    let window_owner = settled.frame.bus_name().to_owned();
    let others: Vec<&String> = owners
        .iter()
        .filter(|owner| **owner != window_owner)
        .collect();
    assert_eq!(
        others.len(),
        1,
        "one of {owners:?} owns the window {window_owner} and the other does not"
    );
    assert!(
        children_of(&connection, others[0], REGISTRY_ROOT_PATH).is_empty(),
        "the connection {} that owns no window has children",
        others[0]
    );
    println!(
        "qt_live connections: window owner {window_owner}, empty connection {}",
        others[0]
    );
    let entries = rig.entries(&settled.frame, true);
    assert!(!entries.is_empty());
    for (_, entry) in &entries {
        let handle = rig
            .resolve(entry)
            .unwrap_or_else(|error| panic!("{:?}: {error:?}", entry.identity.name));
        let element = crate::tree::atspi_element(&handle).expect("Linux handle");
        assert_eq!(
            element.bus_name(),
            window_owner,
            "{:?} resolved through the connection that owns no window",
            entry.identity.name
        );
    }
}
