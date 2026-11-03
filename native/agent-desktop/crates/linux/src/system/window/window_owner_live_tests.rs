use super::*;
use crate::system::x11::control::window_facts::read_facts;

#[test]
#[ignore = "requires an owned GTK window in a private X11 session"]
fn window_op_live_foreign_owner_refuses_writes_and_readback() {
    let bus = SharedBus::default();
    let mut launched = Launched::new();
    let pid = spawn(&mut launched, "gtk3");
    let window = wait_for(&bus, pid);
    let xid = xid_of(pid);
    let id = u32::from_str_radix(xid.trim_start_matches("0x"), 16).expect("XID");
    let owner = agent_desktop_core::ProcessIdentity::new(
        pid,
        window.process_instance.clone().expect("instance"),
    );
    assert!(!hidden(&xid));
    text(
        "xprop",
        &[
            "-id",
            &xid,
            "-f",
            "_NET_WM_PID",
            "32c",
            "-set",
            "_NET_WM_PID",
            "1",
        ],
    );
    let foreign = text("xprop", &["-id", &xid, "_NET_WM_PID"]);
    let refused = write_window(id, &WindowWrite::Iconify, &owner, deadline(5_000));
    let read = read_facts(id, &owner, deadline(5_000));
    let hidden_after_refusal = hidden(&xid);
    text(
        "xprop",
        &[
            "-id",
            &xid,
            "-f",
            "_NET_WM_PID",
            "32c",
            "-set",
            "_NET_WM_PID",
            &pid.to_string(),
        ],
    );
    assert!(foreign.trim_end().ends_with("= 1"), "{foreign}");
    assert_eq!(refused, Err(ControlError::StaleWindow));
    assert!(matches!(
        read,
        crate::system::x11::control::ControlRead::Unavailable
    ));
    assert!(!hidden_after_refusal);
    write_window(id, &WindowWrite::Iconify, &owner, deadline(5_000)).expect("current owner");
    wait_until("the owned window is hidden", || hidden(&xid));
    assert!(
        read_facts(id, &owner, deadline(5_000))
            .ready()
            .expect("owned read")
            .hidden
    );
    apply(&window, WindowOp::Restore).expect("restore owned window");
    wait_until("restored", || !hidden(&xid));
}
