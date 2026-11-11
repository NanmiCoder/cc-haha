use super::*;
use crate::system::signal::signal_live_apps::{Rig, do_action, identity_of, main_menu_toggle};

/// The oracle connects after the wake, so its bus owner changes cannot satisfy the wait.
#[test]
#[ignore = "opens a real Calculator menu; run inside a private session"]
fn a_registered_native_change_wakes_without_predicate_polling() {
    let mut rig = Rig::new();
    let pid = rig.spawn("gnome-calculator", &[]);
    let (_, process) = identity_of(&rig, pid);
    let toggle = main_menu_toggle(&rig, pid);
    let mut subscription = Subscription::open(
        rig.bus(),
        &SignalFilter {
            process: Some(process),
            ..Default::default()
        },
        Deadline::after(10_000).unwrap(),
    )
    .unwrap();
    do_action(&rig.connection, &toggle);
    let deadline = Deadline::after(10_000).unwrap();
    subscription.wait(deadline).unwrap();
    assert!(!deadline.is_expired(), "native event was not received");
    let output = std::process::Command::new("python3")
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
    assert time.monotonic()<until,'native menu did not open'
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
    drop(subscription);
}
