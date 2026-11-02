use agent_desktop_core::{AdapterError, Deadline, SystemOps};
use zbus::zvariant::OwnedValue;

use super::live_launch::{Launched, nonce};
use super::live_offscreen_live_tests::scripts::{GTK3_STRIP, GTK4_STRIP, intersects, window_rect};
use super::live_offscreen_live_tests::target_named;
use crate::actions::scroll::scroll_crawl::{orientation_of, role_of};
use crate::actions::scroll::scroll_find_bar::Orientation;
use crate::actions::scroll_into_view;
use crate::system::{PROPERTIES_INTERFACE, SharedBus, within};
use crate::tree::vocabulary::role_numbers::SCROLL_BAR;
use crate::tree::{AtspiElement, list_children};

const VALUE_INTERFACE: &str = "org.a11y.atspi.Value";

fn current_value(bus: &SharedBus, bar: &AtspiElement) -> f64 {
    let deadline = Deadline::after(3_000).expect("deadline");
    let connection = bus.get(deadline).expect("bus");
    within(deadline, async {
        let reply = connection
            .inner()
            .call_method(
                Some(bar.bus_name()),
                bar.path(),
                Some(PROPERTIES_INTERFACE),
                "Get",
                &(VALUE_INTERFACE, "CurrentValue"),
            )
            .await
            .map_err(|error| AdapterError::internal(error.to_string()))?;
        let value = reply
            .body()
            .deserialize::<OwnedValue>()
            .map_err(|error| AdapterError::internal(error.to_string()))?;
        value
            .downcast_ref::<f64>()
            .map_err(|error| AdapterError::internal(error.to_string()))
    })
    .expect("the bar value reads")
}

fn horizontal_bar(bus: &SharedBus, frame: &AtspiElement) -> AtspiElement {
    let deadline = Deadline::after(5_000).expect("deadline");
    let connection = bus.get(deadline).expect("bus");
    let found = within(deadline, async {
        let mut bars = Vec::new();
        let mut queue = vec![frame.clone()];
        let mut seen = 0;
        while let Some(node) = queue.pop() {
            seen += 1;
            if seen > 2_000 {
                break;
            }
            for (name, path) in list_children(connection.inner(), &node).await? {
                let child = AtspiElement::new(name, path, node.pid());
                if role_of(connection.inner(), &child).await == SCROLL_BAR {
                    let way = orientation_of(connection.inner(), &child).await;
                    bars.push((child.clone(), way));
                }
                queue.push(child);
            }
        }
        Ok(bars)
    })
    .expect("the container lists");
    assert!(!found.is_empty(), "the scroller exposes no scroll bar");
    let ways: Vec<Orientation> = found.iter().map(|(_, way)| *way).collect();
    assert!(
        !ways.contains(&Orientation::Unknown),
        "a bar orientation is unreadable: {ways:?}"
    );
    let mut horizontal = found
        .into_iter()
        .filter(|(_, way)| *way == Orientation::Horizontal);
    let (bar, _) = horizontal
        .next()
        .unwrap_or_else(|| panic!("no horizontal bar in {ways:?}"));
    assert!(
        horizontal.next().is_none(),
        "two horizontal bars in {ways:?}"
    );
    bar
}

fn strip_case(label: &str, source: &str) {
    let dir = std::env::temp_dir().join(nonce(label));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    let script = dir.join("app.py");
    std::fs::write(&script, source).expect("script");
    let mut launched = Launched::new();
    launched.scratch.push(dir);
    let script_arg = script.to_string_lossy().into_owned();
    let pid = launched.spawn_with_env("python3", &[&script_arg], &[]);
    let scene = super::physical_live_rig::Scene::attach(launched, pid, String::new(), 40);
    let adapter = &scene.adapter;
    let bus = &scene.bus;
    let frame = &scene.frame;
    let target = target_named(adapter, frame, "Col 250").expect("Col 250 is in the tree");
    assert!(
        target.element.scroll_container().is_some(),
        "the strip sits in a scroll container"
    );
    let bar = horizontal_bar(bus, frame);
    let before = current_value(bus, &bar);
    let frame_rect = window_rect(bus, frame);
    assert_ne!(
        intersects(window_rect(bus, &target.element), frame_rect),
        Some(true),
        "[{label}] Col 250 starts on screen"
    );
    let deadline = Deadline::after(10_000).expect("deadline");
    let lease = SystemOps::acquire_interaction_lease(adapter, deadline).expect("lease");
    scroll_into_view(bus, &target.handle, &lease).expect("the item scrolls into view");
    let after = current_value(bus, &bar);
    let own = window_rect(bus, &target.element);
    println!("strip_live {label}: bar {before} -> {after}, own {own:?}, frame {frame_rect:?}");
    assert!(after > before, "[{label}] the bar did not move right");
    assert_eq!(intersects(own, frame_rect), Some(true), "[{label}] {own:?}");
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn strip_live_gtk3_horizontal_bar_scrolls_a_far_right_item_into_view() {
    strip_case("gtk3-strip", GTK3_STRIP);
}

#[test]
#[ignore = "drives a real desktop application; run through scripts/private-session.sh"]
fn strip_live_gtk4_horizontal_bar_scrolls_a_far_right_item_into_view() {
    strip_case("gtk4-strip", GTK4_STRIP);
}
