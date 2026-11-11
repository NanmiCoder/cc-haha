use agent_desktop_core::{Action, ActionOps, ActionRequest, DeliveryDisposition, ErrorCode};

use super::live_rig::{Rig, lease};

fn rig_with_two_items(name: &str) -> Rig {
    let mut rig = Rig::new(name);
    rig.spawn(&["watcher", "watcher"]);
    rig.spawn(&["kde", "KdeItem", "Dropbox", "menu"]);
    rig.spawn(&["ayatana", "AyaItem", "Slack", "menu"]);
    rig
}

fn item<'a>(view: &'a super::view::TrayView, title: &str) -> &'a super::tray_item::TrayItem {
    view.items
        .iter()
        .find(|item| item.evidence.title == title)
        .unwrap_or_else(|| panic!("the tray lists '{title}'"))
}

#[test]
#[ignore = "needs a private session bus; run through scripts/private-session.sh"]
fn tray_live_lists_registered_items_with_identity_methods_and_menu() {
    let rig = rig_with_two_items("list");
    let view = rig.view();
    assert_eq!(view.items.len(), 2, "{:?}", rig.log());
    let kde = item(&view, "Dropbox");
    assert!(kde.target.owner.starts_with(':'), "{:?}", kde.target);
    assert_eq!(kde.target.object_path, "/StatusNotifierItem");
    assert_eq!(
        kde.evidence.methods,
        ["Activate", "ContextMenu", "SecondaryActivate", "Scroll"]
    );
    let layout = kde.layout.as_ref().expect("the menu layout parsed");
    let labels: Vec<&str> = layout
        .root
        .children
        .iter()
        .map(|e| e.label.as_str())
        .collect();
    assert_eq!(labels, ["Open", "", "Disabled", "Check", "More"]);
    assert!(layout.root.children[1].separator);
    assert!(!layout.root.children[2].enabled);
    assert_eq!(layout.root.children[3].checked, Some(false));
    assert_eq!(layout.root.children[4].children.len(), 1);
    let aya = item(&view, "Slack");
    assert_eq!(
        aya.evidence.methods,
        ["Scroll", "SecondaryActivate", "XAyatanaSecondaryActivate"]
    );
    assert!(
        aya.target
            .object_path
            .starts_with("/org/ayatana/NotificationItem/")
    );
}

#[test]
#[ignore = "needs a private session bus; run through scripts/private-session.sh"]
fn tray_live_marks_passive_from_status_and_not_from_geometry() {
    let mut rig = rig_with_two_items("passive");
    assert!(!item(&rig.view(), "Slack").evidence.passive);
    rig.signal(2, "-USR1");
    rig.wait_for("status AyaItem Passive");
    assert!(item(&rig.view(), "Slack").evidence.passive);
    rig.signal(2, "-USR1");
    rig.wait_for("status AyaItem Active");
    assert!(!item(&rig.view(), "Slack").evidence.passive);
    rig.stop(1);
}

#[test]
#[ignore = "needs a private session bus; run through scripts/private-session.sh"]
fn tray_live_context_menu_uses_the_primary_context_method() {
    let rig = rig_with_two_items("context-menu");
    let view = rig.view();
    let kde = rig.item_entry(item(&view, "Dropbox"));
    let handle = rig.resolve(&kde).expect("the KDE-style item resolves");
    rig.adapter
        .execute_action(
            &handle,
            ActionRequest::headless(Action::RightClick),
            &lease(),
        )
        .expect("ContextMenu is delivered");
    rig.wait_for("item KdeItem method ContextMenu 0 0");
}

#[test]
#[ignore = "protocol receivers with colliding shell labels; private session only"]
fn tray_live_system_titles_use_only_their_own_advertised_protocol_methods() {
    let mut rig = Rig::new("system-title");
    rig.spawn(&["watcher", "watcher"]);
    rig.spawn(&["kde", "KdeItem", "System", "menu"]);
    rig.spawn(&["ayatana", "AyaItem", "System", "menu"]);
    let view = rig.view();
    assert_eq!(view.items.len(), 2);
    assert_ne!(view.items[0].target.owner, view.items[1].target.owner);
    for item in &view.items {
        let live = super::live::element(&item.target, super::live_rig::deadline(5_000)).unwrap();
        assert!(live.bounds.is_none());
        assert_eq!(live.state.offscreen, None);
        let handle = rig.resolve(&rig.item_entry(item)).unwrap();
        for request in [
            ActionRequest::headless(Action::Click),
            ActionRequest::headed(Action::Click),
        ] {
            let result = rig.adapter.execute_action(&handle, request, &lease());
            if item
                .evidence
                .methods
                .iter()
                .any(|method| method == "Activate")
            {
                result.expect("the item's own method is supported");
            } else {
                let error = result.expect_err("title equality cannot prove a native receiver");
                assert_eq!(error.code, ErrorCode::ActionNotSupported);
                assert_eq!(
                    error.disposition.delivery(),
                    DeliveryDisposition::NotDelivered
                );
            }
        }
    }
    rig.wait_for_nth("item KdeItem method Activate 0 0", 2);
    assert_eq!(
        rig.count("item AyaItem method"),
        0,
        "unsupported item receives no call"
    );
    println!("independent receiver log: {:?}", rig.log());
}

#[test]
#[ignore = "needs a private session bus; run through scripts/private-session.sh"]
fn tray_live_menu_pick_validates_then_sends_the_event() {
    let rig = rig_with_two_items("menu");
    let view = rig.view();
    let kde = item(&view, "Dropbox");
    let pick = |id, labels: &[&str]| {
        let handle = rig.resolve(&rig.menu_entry(kde, id, labels))?;
        rig.adapter
            .execute_action(&handle, ActionRequest::headless(Action::Click), &lease())
    };

    pick(1, &["Open"]).expect("an enabled entry is picked");
    rig.wait_for("menu KdeItem Event 1 clicked");

    let error = pick(3, &["Disabled"]).expect_err("a disabled entry is refused");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    let error = pick(2, &[""]).expect_err("a separator is refused");
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert_eq!(rig.count("Event 3"), 0);
    assert_eq!(rig.count("Event 2"), 0);

    let result = pick(4, &["Check"]).expect("a checkable entry is picked");
    assert_eq!(
        result.disposition().delivery(),
        DeliveryDisposition::DeliveredVerified
    );
    rig.wait_for("menu KdeItem Event 4 clicked");

    pick(5, &["More"]).expect("a submenu parent is opened");
    rig.wait_for("menu KdeItem AboutToShow 5");
    assert_eq!(rig.count("Event 5"), 0);

    pick(6, &["More", "Child"]).expect("a nested entry is picked");
    rig.wait_for("menu KdeItem Event 6 clicked");
}

#[test]
#[ignore = "needs a private session bus; run through scripts/private-session.sh"]
fn tray_live_a_restarted_owner_is_a_stale_ref_and_never_reached() {
    let mut rig = rig_with_two_items("churn");
    let view = rig.view();
    let old = rig.item_entry(item(&view, "Dropbox"));
    let old_owner = item(&view, "Dropbox").target.owner.clone();
    rig.resolve(&old)
        .expect("the item resolves before it restarts");
    rig.stop(1);
    rig.spawn(&["kde", "KdeItem", "Dropbox", "menu"]);
    let activations = rig.count("method Activate");
    let error = rig
        .resolve(&old)
        .err()
        .expect("the old unique name is gone");
    assert_eq!(error.code, ErrorCode::StaleRef);
    let fresh = rig.view();
    let new_owner = item(&fresh, "Dropbox").target.owner.clone();
    assert_ne!(new_owner, old_owner);
    assert_eq!(rig.count("method Activate"), activations);
}

#[test]
#[ignore = "needs a private session bus; run through scripts/private-session.sh"]
fn tray_live_an_item_that_exits_drops_out_of_the_list() {
    let mut rig = rig_with_two_items("exit");
    assert_eq!(rig.view().items.len(), 2);
    rig.stop(2);
    let started = std::time::Instant::now();
    while rig.view().items.len() != 1 {
        assert!(started.elapsed().as_secs() < 10, "{:?}", rig.log());
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert_eq!(rig.view().items[0].evidence.title, "Dropbox");
}

#[test]
#[ignore = "real SNI menu failure and receiver log; private session only"]
fn tray_live_unreadable_menu_refuses_without_hiding_the_registered_item() {
    let mut rig = Rig::new("unreadable-menu");
    rig.spawn(&["watcher", "watcher"]);
    rig.spawn(&["kde", "KdeItem", "通知", "menu"]);
    for request in [
        ActionRequest::headless(Action::Click),
        ActionRequest::headed(Action::Click),
    ] {
        let view = rig.view();
        let target = &view.items[0];
        let entry = rig.menu_entry(target, 1, &["Open"]);
        let handle = rig.resolve(&entry).expect("readable menu resolves");
        let received = rig.count("Event 1 clicked");
        rig.adapter
            .execute_action(&handle, request.clone(), &lease())
            .expect("supported protocol event is delivered");
        rig.wait_for_nth("Event 1 clicked", received + 1);
        rig.signal(1, "-USR2");
        rig.wait_for_nth("layout KdeItem refused", received + 1);
        let oracle = std::process::Command::new("busctl")
            .args([
                "--user",
                "--",
                "call",
                &target.target.owner,
                "/MenuBar",
                "com.canonical.dbusmenu",
                "GetLayout",
                "iias",
                "0",
                "-1",
                "0",
            ])
            .output()
            .unwrap();
        assert!(!oracle.status.success());
        assert!(String::from_utf8_lossy(&oracle.stderr).contains("layout read refused"));
        let error = super::view::read(super::live_rig::deadline(5_000))
            .err()
            .expect("failed menu read is not a complete tray inventory");
        assert!(
            error
                .platform_detail
                .unwrap()
                .contains("layout read refused")
        );
        let direct = rig.resolve(&rig.item_entry(target)).unwrap();
        let activations = rig.count("method Activate");
        rig.adapter
            .execute_action(&direct, request.clone(), &lease())
            .expect("a direct item action does not depend on its menu layout");
        rig.wait_for_nth("method Activate", activations + 1);
        rig.adapter
            .execute_action(&handle, request, &lease())
            .expect_err("an old handle cannot bypass a fresh failed menu read");
        assert_eq!(rig.count("Event 1 clicked"), received + 1);
        rig.signal(1, "-USR2");
        rig.wait_for_nth("layout KdeItem readable", received + 1);
        assert_eq!(rig.view().items.len(), 1);
    }
    println!("independent SNI receiver log: {:?}", rig.log());
}

#[test]
#[ignore = "real SNI state changes and receiver log; private session only"]
fn tray_live_passive_parent_refuses_item_and_menu_delivery_after_preflight() {
    use agent_desktop_core::ObservationOps;

    let mut rig = Rig::new("passive-delivery");
    rig.spawn(&["watcher", "watcher"]);
    rig.spawn(&["kde", "KdeItem", "通知", "menu"]);
    let view = rig.view();
    let item = &view.items[0];
    let handles = [
        rig.resolve(&rig.item_entry(item)).unwrap(),
        rig.resolve(&rig.menu_entry(item, 1, &["Open"])).unwrap(),
    ];
    for (round, request) in [
        ActionRequest::headless(Action::Click),
        ActionRequest::headed(Action::Click),
    ]
    .into_iter()
    .enumerate()
    {
        for handle in &handles {
            let live = rig
                .adapter
                .get_live_element(handle, super::live_rig::deadline(5_000))
                .unwrap();
            assert_eq!(live.state.hidden, Some(false));
            let activations = rig.count("method Activate");
            let events = rig.count("Event 1 clicked");
            rig.adapter
                .execute_action(handle, request.clone(), &lease())
                .unwrap();
            if super::target_of(handle).unwrap().entry_id.is_some() {
                rig.wait_for_nth("Event 1 clicked", events + 1);
            } else {
                rig.wait_for_nth("method Activate", activations + 1);
            }
        }
        rig.signal(1, "-USR1");
        rig.wait_for_nth("status KdeItem Passive", round + 1);
        let delivered = rig.count("method Activate") + rig.count("Event 1 clicked");
        for handle in &handles {
            let live = rig
                .adapter
                .get_live_element(handle, super::live_rig::deadline(5_000))
                .unwrap();
            assert_eq!(
                live.state.hidden,
                Some(true),
                "parent Status must reach menu preflight"
            );
            let error = rig
                .adapter
                .execute_action(handle, request.clone(), &lease())
                .expect_err("a state change after preflight must refuse dispatch");
            assert_eq!(
                error.disposition.delivery(),
                DeliveryDisposition::NotDelivered
            );
        }
        assert_eq!(
            rig.count("method Activate") + rig.count("Event 1 clicked"),
            delivered
        );
        rig.signal(1, "-USR1");
        rig.wait_for_nth("status KdeItem Active", round * 2 + 1);
        rig.signal(1, "-WINCH");
        rig.wait_for_nth("status KdeItem unreadable", round + 1);
        for handle in &handles {
            rig.adapter
                .get_live_element(handle, super::live_rig::deadline(5_000))
                .expect_err("unknown Status cannot prove visibility");
            let error = rig
                .adapter
                .execute_action(handle, request.clone(), &lease())
                .expect_err("unknown Status cannot authorize delivery");
            assert_eq!(
                error.disposition.delivery(),
                DeliveryDisposition::NotDelivered
            );
        }
        assert_eq!(
            rig.count("method Activate") + rig.count("Event 1 clicked"),
            delivered
        );
        rig.signal(1, "-WINCH");
        rig.wait_for_nth("status KdeItem Active", (round + 1) * 2);
    }
    println!("independent SNI receiver log: {:?}", rig.log());
}
