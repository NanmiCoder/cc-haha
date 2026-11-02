use crate::system::signal::signal_live_apps::{Rig, do_action, identity_of, main_menu_toggle};
use crate::system::{list_windows, x11};
use agent_desktop_core::{Deadline, ErrorCode, WindowFilter};
use std::process::Command;

fn deadline() -> Deadline {
    Deadline::after(10_000).unwrap()
}

fn showing_menu(pid: u32) {
    let output = Command::new("python3")
        .args([
            "-c",
            r#"
import gi,sys,time
gi.require_version('Atspi','2.0')
from gi.repository import Atspi
Atspi.set_timeout(3000,3000)
root=Atspi.get_desktop(0)
app=next(root.get_child_at_index(i) for i in range(root.get_child_count())
         if root.get_child_at_index(i).get_process_id()==int(sys.argv[1]))
def nodes(node):
    yield node
    for i in range(node.get_child_count()): yield from nodes(node.get_child_at_index(i))
until=time.monotonic()+5
while not any(n.get_role()==Atspi.Role.MENU and n.get_state_set().contains(Atspi.StateType.SHOWING) for n in nodes(app)):
    assert time.monotonic()<until,'native menu is not showing'
    time.sleep(.05)
print('independent AT-SPI: Calculator menu is showing')
"#,
            &pid.to_string(),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
}

#[test]
#[ignore = "changes an owned Calculator popup type; run inside private managed X11"]
fn a_typed_popup_preserves_its_window_and_an_unclassified_popup_keeps_it_listed() {
    let mut rig = Rig::new();
    let pid = rig.spawn("gnome-calculator", &[]);
    let (app, _) = identity_of(&rig, pid);
    let toggle = main_menu_toggle(&rig, pid);
    do_action(&rig.connection, &toggle);
    showing_menu(pid);
    let filter = WindowFilter {
        app: Some(app),
        focused_only: false,
    };
    let registry =
        crate::system::registry::read_registry_for(rig.bus(), Some(pid), deadline()).unwrap();
    let windows = crate::system::window::window_ops::windows_of(
        rig.bus(),
        &registry,
        |app| app.root.pid() == pid,
        deadline(),
    )
    .unwrap();
    let expired = super::without_helpers(windows.clone(), Deadline::after(0).unwrap()).unwrap_err();
    assert_eq!(expired.code, ErrorCode::Timeout);
    assert_eq!(
        super::without_helpers(windows, deadline()).unwrap().len(),
        1
    );
    let listed = list_windows(rig.bus(), &filter, deadline())
        .expect("a typed native popup must preserve its managed window");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pid.get(), pid);
    let clients = x11::control::toplevels_of(pid, deadline())
        .ready()
        .unwrap()
        .into_iter()
        .map(|window| window.id)
        .collect();
    let x11::native_population::NativePopulation::Complete { menus } =
        x11::native_population::read(pid, clients, deadline())
    else {
        panic!("the native popup inventory must be complete");
    };
    assert_eq!(menus.len(), 1);
    let id = menus[0].id.to_string();
    let property = Command::new("xprop")
        .args(["-id", &id, "_NET_WM_WINDOW_TYPE"])
        .output()
        .unwrap();
    assert!(property.status.success());
    let text = String::from_utf8(property.stdout).unwrap();
    let original = text.split_once('=').unwrap().1.trim();
    assert!(matches!(
        original,
        "_NET_WM_WINDOW_TYPE_MENU"
            | "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU"
            | "_NET_WM_WINDOW_TYPE_POPUP_MENU"
    ));
    let native = Command::new("xwininfo")
        .args(["-id", &id, "-stats"])
        .output()
        .unwrap();
    assert!(native.status.success());
    let native = String::from_utf8(native.stdout).unwrap();
    assert!(
        native.contains("Override Redirect State: yes") && native.contains("Map State: IsViewable")
    );
    let set = |kind: &str| {
        assert!(
            Command::new("xprop")
                .args([
                    "-id",
                    &id,
                    "-f",
                    "_NET_WM_WINDOW_TYPE",
                    "32a",
                    "-set",
                    "_NET_WM_WINDOW_TYPE",
                    kind
                ])
                .status()
                .unwrap()
                .success()
        );
    };
    set("_AGENT_DESKTOP_UNCLASSIFIED_POPUP");
    let unclassified = list_windows(rig.bus(), &filter, deadline());
    showing_menu(pid);
    set(original);
    let unclassified = unclassified.expect("an unclassified popup must not refuse the listing");
    assert_eq!(unclassified.len(), 1);
    assert_eq!(unclassified[0].pid.get(), pid);
    assert_eq!(
        list_windows(rig.bus(), &filter, deadline()).unwrap().len(),
        1
    );
    do_action(&rig.connection, &toggle);
}
