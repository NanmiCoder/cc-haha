use super::live_bench::Bench;
use super::live_scroll_tests::read;
use super::physical_receiver_world::ReceiverWorld;
use super::physical_x11_oracle::{cover_above, cover_viewable, wait_for_free_keyboard_focus};
use crate::input::physical::target_pointer::{scroll_steps, wheel_deltas};
use crate::input::physical::target_world::LiveWorld;
use crate::input::x11::live_tests::shell_stage_has_focus;
use crate::tree::live::live_launch::{Launched, nonce};
use agent_desktop_core::{DeliverySemantics, InteractionPolicy, SystemOps};
use std::time::Duration;

const WHEEL_APP: &str = r#"
import gi, json, pathlib, sys
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk, GLib
window = Gtk.Window(title=sys.argv[1])
window.set_default_size(300, 200)
window.move(100, 100)
late = sys.argv[4] == "late"
counts = {"Target": 0, "Cover": 0, "delta": 0, "covered": not late, "triggered": False, "ready": False}
def record():
    counts["offset"] = adjustment.get_value()
    counts["active"] = window.is_active()
    path = pathlib.Path(sys.argv[2])
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(counts))
    temporary.replace(path)
    return False
target = Gtk.ScrolledWindow()
target.get_accessible().set_name("Target")
target.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.ALWAYS)
column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
for index in range(100):
    column.pack_start(Gtk.Label(label="Row %s" % index), False, False, 0)
target.add(column)
window.add(target)
adjustment = target.get_vadjustment()
cover = Gtk.Window(type=Gtk.WindowType.POPUP, title="Cover")
cover.set_decorated(False)
cover.set_keep_above(True)
cover.set_default_size(300, 200)
interceptor = Gtk.Button(label="Cover")
cover.add(interceptor)
def align(*_):
    native = window.get_window()
    offset = target.translate_coordinates(window, 0, 0)
    if native and offset:
        x, y = native.get_origin()[-2:]
        cover.move(x + offset[0], y + offset[1])
        cover.resize(target.get_allocated_width(), target.get_allocated_height())
        if cover.get_visible():
            cover.get_window().raise_()
        Gdk.Display.get_default().sync()
    return False
window.connect('configure-event', align)
target.connect('size-allocate', align)
def wheel(widget, event):
    counts["Target"] += 1
    counts["delta"] += 120 if event.direction == Gdk.ScrollDirection.UP else -120
    if late and not counts["triggered"] and counts["Target"] == 10:
        counts["triggered"] = True
        align()
        cover.show_all()
        align()
        Gdk.Display.get_default().sync()
        counts["covered"] = True
    GLib.idle_add(record)
    return False
def intercepted(*_):
    counts["Cover"] += 1
    record()
    return True
target.connect('scroll-event', wheel)
interceptor.add_events(Gdk.EventMask.SCROLL_MASK)
interceptor.connect('scroll-event', intercepted)
def poll():
    uncovered = pathlib.Path(sys.argv[3]).exists()
    if uncovered:
        cover.hide()
        window.present()
        counts["covered"] = False
    record()
    return not (uncovered and window.is_active())
def ready():
    if not window.is_active():
        return True
    if sys.argv[5] == "up":
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())
    counts["initial_offset"] = adjustment.get_value()
    if not late:
        align()
        cover.show_all()
        align()
    counts["ready"] = True
    record()
    return False
window.show_all()
GLib.idle_add(ready)
GLib.timeout_add(50, poll)
Gtk.main()
"#;

#[test]
#[ignore = "drives GTK in scripts/private-session.sh --wm"]
fn ref_wheel_refuses_a_covering_window_and_reaches_the_uncovered_target() {
    for mode in ["covered", "late"] {
        for direction in [
            agent_desktop_core::Direction::Down,
            agent_desktop_core::Direction::Up,
        ] {
            use agent_desktop_core::{Deadline, ErrorCode, HitTestResult, ObservationOps, Point};
            wait_for_free_keyboard_focus(Duration::from_secs(8))
                .unwrap_or_else(|reason| panic!("{mode} {direction:?}: {reason}"));
            let mut launched = Launched::new();
            let tag = nonce("wheel-cover");
            let scratch = std::env::temp_dir().join(&tag);
            std::fs::create_dir_all(&scratch).unwrap();
            launched.scratch.push(scratch.clone());
            let state = scratch.join("state.json");
            let uncover = scratch.join("uncover");
            let pid = launched.spawn(
                "python3",
                &[
                    "-c",
                    WHEEL_APP,
                    &tag,
                    state.to_str().unwrap(),
                    uncover.to_str().unwrap(),
                    mode,
                    if matches!(direction, agent_desktop_core::Direction::Up) {
                        "up"
                    } else {
                        "down"
                    },
                ],
            );
            let adapter = crate::LinuxAdapter::new();
            let frame = Bench::wait_for_frame(&adapter, &tag, pid, 20).expect("GTK window");
            let bench = Bench::attach(launched, frame);
            let target = bench.named("Target");
            let hit = || {
                let deadline = Deadline::after(3_000).unwrap();
                let bounds = bench
                    .adapter()
                    .get_element_bounds(&target, deadline)
                    .unwrap()
                    .unwrap();
                bench
                    .adapter()
                    .hit_test(
                        &target,
                        Point {
                            x: bounds.x + bounds.width / 2.0,
                            y: bounds.y + bounds.height / 2.0,
                        },
                        deadline,
                    )
                    .unwrap()
            };
            let intercepted = || matches!(hit(), HitTestResult::InterceptedBy { name, .. } if name.as_deref() == Some("Cover"));
            let aim = || {
                let bounds = bench
                    .adapter()
                    .get_element_bounds(&target, Deadline::after(3_000).unwrap())
                    .unwrap()
                    .unwrap();
                (
                    (bounds.x + bounds.width / 2.0).round() as i32,
                    (bounds.y + bounds.height / 2.0).round() as i32,
                )
            };
            let covered = bench.wait_for(|| {
                (read(&state)["ready"] == true
                    && if mode == "late" {
                        read(&state)["active"] == true
                            && matches!(hit(), HitTestResult::ReachesTarget)
                            && cover_viewable() == Ok(false)
                    } else {
                        cover_above(&tag, aim()).is_ok() && intercepted()
                    })
                .then_some(())
            });
            if covered.is_none() {
                let bounds = bench
                    .adapter()
                    .get_element_bounds(&target, Deadline::after(3_000).unwrap())
                    .unwrap()
                    .unwrap();
                let point = [
                    bounds.x + bounds.width / 2.0,
                    bounds.y + bounds.height / 2.0,
                ];
                std::process::Command::new("xdotool")
                    .args([
                        "mousemove",
                        &point[0].round().to_string(),
                        &point[1].round().to_string(),
                    ])
                    .status()
                    .unwrap();
                for args in [
                    vec!["xdotool", "getmouselocation", "--shell"],
                    vec!["xwininfo", "-root", "-tree"],
                ] {
                    let output = std::process::Command::new(args[0])
                        .args(&args[1..])
                        .output()
                        .unwrap();
                    eprintln!(
                        "native receiver oracle: {}",
                        String::from_utf8_lossy(&output.stdout)
                    );
                }
                panic!(
                    "{mode} {direction:?}: bounds={bounds:?}, state={}, hit={:?}, x11 cover above target={:?}, x11 cover viewable={:?}, shell popup holds the focus={}",
                    read(&state),
                    hit(),
                    cover_above(&tag, aim()),
                    cover_viewable(),
                    shell_stage_has_focus()
                );
            }
            let lease = bench
                .adapter()
                .acquire_interaction_lease(Deadline::after(30_000).unwrap())
                .unwrap();
            let await_cover = |checks| {
                if mode == "late" && checks == 2 {
                    bench
                        .wait_for(|| {
                            (read(&state)["covered"] == true
                                && cover_above(&tag, aim()).is_ok()
                                && intercepted())
                            .then_some(())
                        })
                        .unwrap_or_else(|| {
                            panic!(
                                "{mode} {direction:?}: the first-burst cover never stood above the target: x11={:?}, state={}",
                                cover_above(&tag, aim()),
                                read(&state)
                            )
                        });
                }
            };
            let world = ReceiverWorld::new(
                LiveWorld {
                    bus: bench.adapter().bus(),
                    lease: &lease,
                },
                &await_cover,
            );
            let element = crate::tree::atspi_element(&target).unwrap();
            let deltas = wheel_deltas(&direction, 21);
            let error = scroll_steps(
                &world,
                element,
                deltas,
                InteractionPolicy::headed(),
                lease.deadline(),
            )
            .expect_err("covering window intercepts wheel");
            assert_eq!(error.code, ErrorCode::ActionFailed);
            let details = error.details.expect("interception details");
            assert_eq!(details["check"], "receives_events");
            assert_eq!(details["interceptor"]["name"], "Cover");
            let sent: u32 = if mode == "late" { 10 } else { 0 };
            assert_eq!(details["delivered_clicks"], sent);
            assert_eq!(
                error.disposition,
                if mode == "late" {
                    DeliverySemantics::delivered_unverified()
                } else {
                    DeliverySemantics::not_delivered()
                }
            );
            assert_eq!(
                read(&state)["delta"].as_i64().unwrap().unsigned_abs(),
                u64::from(sent) * 120
            );
            assert_eq!(read(&state)["Cover"], 0);
            if mode == "covered" {
                assert_eq!(read(&state)["offset"], read(&state)["initial_offset"]);
            }
            std::fs::write(&uncover, "").unwrap();
            assert!(
                bench
                    .wait_for(|| {
                        let observed = read(&state);
                        (observed["covered"] == false
                            && observed["active"] == true
                            && cover_viewable() == Ok(false))
                        .then_some(())
                    })
                    .is_some(),
                "{mode} {direction:?}: the app never reported the cover gone and its window active: {}",
                read(&state)
            );
            assert!(
                bench
                    .wait_for(|| matches!(hit(), HitTestResult::ReachesTarget).then_some(()))
                    .is_some(),
                "{mode} {direction:?}: the uncovered target never received the pointer: {:?}",
                hit()
            );
            scroll_steps(
                &world.live,
                element,
                deltas,
                InteractionPolicy::headed(),
                lease.deadline(),
            )
            .expect("uncovered target");
            assert!(
                bench
                    .wait_for(|| {
                        (read(&state)["delta"].as_i64().unwrap().unsigned_abs()
                            == u64::from(sent + 21) * 120)
                            .then_some(())
                    })
                    .is_some(),
                "{mode} {direction:?}: {}",
                read(&state)
            );
            assert_eq!(read(&state)["Cover"], 0);
            let observed = read(&state);
            eprintln!("{mode} {direction:?} independent wheel receipt: {observed}");
            let offset = observed["offset"].as_f64().unwrap();
            let initial = observed["initial_offset"].as_f64().unwrap();
            assert!(if matches!(direction, agent_desktop_core::Direction::Up) {
                offset < initial
            } else {
                offset > initial
            });
        }
    }
}
