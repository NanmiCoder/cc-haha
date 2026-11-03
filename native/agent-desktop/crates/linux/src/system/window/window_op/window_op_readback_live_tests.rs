use agent_desktop_core::{Deadline, ProcessIdentity, WindowOp};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, PropMode};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

use super::super::{FrameWorld, Live, SharedBus};
use super::{DeliverySemantics, ErrorCode, ensure_owned_after};
use crate::system::window::window_op_live_tests::{
    apply, maximized, spawn, text, wait_for, xid_of,
};
use crate::tree::live::live_launch::Launched;

#[test]
#[ignore = "removes a private WM property; run inside scripts/private-session.sh --wm"]
fn window_op_live_missing_client_list_does_not_claim_a_live_window_disappeared() {
    let display = crate::system::x11::live_display::private_display();
    let (connection, screen) = RustConnection::connect(Some(&display)).expect("private display");
    let root = connection.setup().roots[screen].root;
    let atom = connection
        .intern_atom(false, b"_NET_CLIENT_LIST")
        .expect("client atom")
        .reply()
        .expect("atom")
        .atom;
    for _ in 0..2 {
        let bus = SharedBus::default();
        let mut launched = Launched::new();
        let pid = spawn(&mut launched, "gtk3");
        let win = wait_for(&bus, pid);
        let xid = xid_of(pid);
        let client = u32::from_str_radix(xid.trim_start_matches("0x"), 16).expect("XID");
        apply(&win, WindowOp::Maximize).expect("real window write");
        assert_eq!(maximized(&xid), (true, true), "xprop verifies the write");
        let deadline = Deadline::after(10_000).expect("budget");
        let live = Live {
            frame: FrameWorld::new(&bus, &win, deadline).expect("live frame"),
            owner: ProcessIdentity::new(pid, win.process_instance.clone().expect("instance")),
            deadline,
        };
        let listed = connection
            .get_property(false, root, atom, AtomEnum::WINDOW, 0, 4096)
            .expect("list request")
            .reply()
            .expect("list reply")
            .value32()
            .expect("window IDs")
            .collect::<Vec<_>>();
        connection
            .delete_property(root, atom)
            .expect("remove own client list")
            .check()
            .expect("removed");
        connection.sync().expect("fault installed");
        let outcome = ensure_owned_after(&live, &win, client);
        connection
            .change_property32(PropMode::REPLACE, root, atom, AtomEnum::WINDOW, &listed)
            .expect("restore own client list")
            .check()
            .expect("restored");
        connection.sync().expect("fault removed");
        let error = outcome.expect_err("unreadable ownership is not disappearance");
        assert_eq!(error.code, ErrorCode::ActionFailed);
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
        assert_eq!(
            error.details.expect("cause")["cause"],
            "ownership_unverified"
        );
        assert!(text("xprop", &["-id", &xid, "_NET_WM_PID"]).contains(&pid.to_string()));
        assert!(std::path::Path::new(&format!("/proc/{pid}/exe")).exists());
        ensure_owned_after(&live, &win, client)
            .expect("readable ownership confirms the live window");
        launched.stop();
        let gone =
            ensure_owned_after(&live, &win, client).expect_err("confirmed loss stays missing");
        assert_eq!(gone.code, ErrorCode::WindowNotFound);
        println!(
            "xprop and /proc: live owner {pid}; missing client list = ACTION_FAILED; confirmed exit = WINDOW_NOT_FOUND"
        );
    }
}
