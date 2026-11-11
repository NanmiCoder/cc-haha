use agent_desktop_core::refs::ref_alloc::is_ref_able;
use agent_desktop_core::{
    AccessibilityNode, Deadline, ObservationRequest, ObservationRoot, TreeOptions, WindowInfo,
    WindowState,
};

use super::live_launch::Launched;
use super::live_tree::pid_frame;
use super::walker_live_tests::settle_watching;
use crate::system::{SharedBus, window::window_id};
use crate::tree::observe::observe_tree;

fn refs(node: &AccessibilityNode) -> usize {
    usize::from(is_ref_able(node)) + node.children.iter().map(refs).sum::<usize>()
}

fn nodes(node: &AccessibilityNode) -> usize {
    1 + node.children.iter().map(nodes).sum::<usize>()
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/linux-live-gate.sh"]
fn observe_live_calculator_returns_a_complete_reffed_tree() {
    let bus = SharedBus::default();
    let connection = bus
        .get(Deadline::standard().expect("a standard deadline builds"))
        .expect("the accessibility bus must be reachable");
    let mut launched = Launched::new();
    let pid = launched.spawn("gnome-calculator", &[]);
    let settled = settle_watching(&bus, 30, Some(pid), || pid_frame(&connection, pid))
        .unwrap_or_else(|error| panic!("calculator did not settle: {error}"));
    let id = window_id::encode(settled.frame.bus_name(), settled.frame.path())
        .expect("a registry frame has an encodable address");
    let window = WindowInfo {
        id,
        title: String::new(),
        app: "calculator".to_owned(),
        pid: pid.into(),
        process_instance: None,
        bounds: None,
        state: WindowState::default(),
    };
    let deadline = Deadline::after(10_000).expect("the deadline builds");
    let request = ObservationRequest::snapshot(&TreeOptions::default(), deadline);
    let tree = observe_tree(&bus, ObservationRoot::Window(&window), &request)
        .expect("the window observes");
    assert!(tree.is_complete());
    let (root, complete, observed) = tree
        .into_accessibility_tree_partial()
        .expect("one root projects");
    println!(
        "observe_live calculator: nodes={} observed={observed} refs={} complete={complete} root_role={}",
        nodes(&root),
        refs(&root),
        root.role
    );
    assert!(complete);
    assert!(refs(&root) >= 20, "a calculator has many buttons");

    let oracle = || {
        let output = std::process::Command::new("python3")
            .args([
                "-c",
                "import gi,sys; gi.require_version('Atspi','2.0'); from gi.repository import Atspi; d=Atspi.get_desktop(0); apps=[d.get_child_at_index(i) for i in range(d.get_child_count())]; a=next(a for a in apps if a.get_process_id()==int(sys.argv[1])); assert a.get_child_count()>0; print(a.get_name())",
                &pid.to_string(),
            ])
            .output()
            .expect("independent AT-SPI observer");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    oracle();
    let mut walk = crate::tree::walk::walker::walk_tree(
        &bus,
        &settled.frame,
        &crate::tree::WalkLimits::default(),
        Deadline::after(10_000).unwrap(),
    )
    .expect("a complete live walk before placement");
    assert!(walk.complete);
    zbus::block_on(connection.inner().clone().close()).unwrap();
    let recovered = bus.get(Deadline::after(5_000).unwrap()).unwrap();
    assert_eq!(
        recovered.inner().server_guid(),
        connection.inner().server_guid()
    );
    assert_ne!(
        recovered.inner().unique_name(),
        connection.inner().unique_name()
    );
    crate::tree::placement::node_position::place_nodes(
        &bus,
        &mut walk,
        Deadline::after(5_000).unwrap(),
    )
    .expect("a fresh connection to the same bus can place the live tree");
    assert!(walk.complete);
    oracle();
}
