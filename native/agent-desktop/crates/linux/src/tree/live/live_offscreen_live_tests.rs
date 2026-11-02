use agent_desktop_core::{Deadline, ErrorCode, NativeHandle, ObservationOps, SystemOps};

use super::live_launch::{Launched, nonce};
use super::resolve_live_tests::snapshot_entries;
use crate::LinuxAdapter;
use crate::actions::scroll_into_view;
use crate::system::SharedBus;
use crate::tree::{AtspiElement, atspi_element};

#[path = "live_scroll_scripts.rs"]
pub(in crate::tree) mod scripts;

use scripts::{QT_LIST, pointer};

pub(in crate::tree) struct Target {
    pub(in crate::tree) handle: NativeHandle,
    pub(in crate::tree) element: AtspiElement,
}

pub(in crate::tree) fn target_named(
    adapter: &LinuxAdapter,
    frame: &AtspiElement,
    wanted: &str,
) -> Result<Target, String> {
    let (_, entry) = snapshot_entries(adapter, frame, true)?
        .into_iter()
        .find(|(_, entry)| entry.identity.name.as_deref() == Some(wanted))
        .ok_or_else(|| format!("no target {wanted:?}"))?;
    let handle = adapter
        .resolve_element_strict(&entry, Deadline::after(5_000).expect("deadline"))
        .map_err(|error| error.message)?;
    let element = atspi_element(&handle)
        .cloned()
        .map_err(|error| error.message)?;
    Ok(Target { handle, element })
}

fn scroll_case(
    label: &str,
    adapter: &LinuxAdapter,
    bus: &SharedBus,
    frame: &AtspiElement,
    wanted: &str,
) -> Result<(), String> {
    let handle = target_named(adapter, frame, wanted)?.handle;
    let deadline = Deadline::after(10_000).map_err(|error| error.message)?;
    adapter
        .get_live_state(&handle, deadline)
        .map_err(|error| error.message)?
        .ok_or("no state")?;
    let lease = SystemOps::acquire_interaction_lease(adapter, deadline).map_err(|e| e.message)?;
    let pointer_before = pointer().ok_or("the private X11 pointer is unreadable")?;
    let outcome = scroll_into_view(bus, &handle, &lease);
    let pointer_after = pointer().ok_or("the private X11 pointer is unreadable after scrolling")?;
    assert_eq!(pointer_before, pointer_after, "[{label}] the pointer moved");
    let error = outcome
        .err()
        .ok_or_else(|| format!("[{label}] a refusal was expected"))?;
    assert!(
        matches!(
            error.code,
            ErrorCode::ActionFailed | ErrorCode::ActionNotSupported
        ),
        "[{label}] {error:?}"
    );
    let details = error.details.as_ref().expect("a refusal carries details");
    assert_eq!(details["physical_delivery_started"], false);
    assert_eq!(details["kind"], "scroll_into_view");
    Ok(())
}

fn script_app(
    label: &str,
    program: &str,
    source: &str,
    env: &[(&str, String)],
    wanted: &'static str,
) {
    let adapter = LinuxAdapter::new();
    let bus = SharedBus::default();
    let dir = std::env::temp_dir().join(nonce(label));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let script = dir.join("app.py");
    std::fs::write(&script, source).expect("script");
    let connection = bus
        .get(Deadline::standard().expect("deadline"))
        .expect("bus");
    let mut launched = Launched::new();
    launched.scratch.push(dir);
    let script_arg = script.to_string_lossy().into_owned();
    let pid = launched.spawn_with_env(program, &[&script_arg], env);
    let settled = super::walker_live_tests::settle_watching(&bus, 40, Some(pid), || {
        super::live_tree::pid_frame(&connection, pid)
    })
    .unwrap_or_else(|error| panic!("the app settles: {error}"));
    scroll_case(label, &adapter, &bus, &settled.frame, wanted).expect("the case holds");
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn offscreen_live_qt_list_item_cannot_be_scrolled_to() {
    let python = std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());

    let env = [
        ("QT_ACCESSIBILITY", "1".to_owned()),
        ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
        ("QT_QPA_PLATFORM", "xcb".to_owned()),
    ];
    script_app("qt", &python, QT_LIST, &env, "Item 250");
}
