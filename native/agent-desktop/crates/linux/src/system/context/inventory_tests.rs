use agent_desktop_core::AppInventoryQuery;
use serde_json::json;

use super::*;
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::system::registry::registry_app::assemble;
use crate::tree::AtspiElement;

fn app(pid: u32, name: &str, aliases: &[&str]) -> RegistryApp {
    let mut app = assemble(
        AtspiElement::new(format!(":1.{pid}"), "/root", pid),
        ProcessFacts {
            executable: None,
            comm: name.into(),
            exe_basename: Some(name.into()),
            instance: format!("boot:{pid}"),
        },
        Some(Some(name.into())),
        ToolkitId::default(),
    );
    app.aliases = aliases.iter().map(|alias| (*alias).into()).collect();
    app
}

#[test]
fn one_inventory_preserves_substring_alias_union_instances_and_incomplete_evidence() {
    let mut duplicate = app(2, "editor", &["Notes"]);
    duplicate.root = AtspiElement::new(":2.2", "/root", 2);
    let mut reused = app(2, "editor", &["Notes"]);
    reused.facts.instance = "boot:replacement".into();
    let skipped = json!({"bus": ":1.99", "reason": "identity unavailable"});
    let registry = Registry {
        apps: vec![
            app(1, "notes-app", &[]),
            app(2, "editor", &["Notes"]),
            duplicate,
            reused,
            app(3, "other", &["Notes Extra"]),
        ],
        skipped: vec![skipped.clone()],
    };
    let inventory = finish(
        registry,
        AppInventoryQuery::NameOrAlias("NOTES"),
        &HashSet::from([2]),
        &(0..4)
            .map(|app| AppOutcome {
                app,
                read: RootRead::Read,
            })
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert_eq!(
        inventory
            .apps
            .iter()
            .map(|app| (app.pid.get(), app.process_instance.as_deref()))
            .collect::<Vec<_>>(),
        [
            (1, Some("boot:1")),
            (2, Some("boot:2")),
            (2, Some("boot:replacement"))
        ]
    );
    assert_eq!(
        inventory.apps[1].presentation,
        Some(agent_desktop_core::AppPresentation::Foreground)
    );
    assert_eq!(inventory.skipped, [skipped]);
}

#[test]
fn a_failed_window_read_is_not_evidence_of_background_presentation() {
    for (read, windowed, expected) in [
        (RootRead::TimedOut, HashSet::new(), None),
        (
            RootRead::Read,
            HashSet::new(),
            Some(agent_desktop_core::AppPresentation::Background),
        ),
        (
            RootRead::TimedOut,
            HashSet::from([0]),
            Some(agent_desktop_core::AppPresentation::Foreground),
        ),
    ] {
        let inventory = finish(
            Registry {
                apps: vec![app(8, "x", &[])],
                skipped: vec![],
            },
            AppInventoryQuery::All,
            &windowed,
            &[AppOutcome { app: 0, read }],
        )
        .unwrap();
        assert_eq!(inventory.apps[0].presentation, expected);
        assert_eq!(
            inventory.skipped.len(),
            usize::from(read == RootRead::TimedOut)
        );
    }
}

#[test]
fn an_unread_duplicate_root_cannot_prove_background_in_either_order() {
    for outcomes in [
        [RootRead::Read, RootRead::TimedOut],
        [RootRead::TimedOut, RootRead::Read],
    ] {
        let mut duplicate = app(8, "x", &[]);
        duplicate.root = AtspiElement::new(":2.8", "/root", 8);
        let inventory = finish(
            Registry {
                apps: vec![app(8, "x", &[]), duplicate],
                skipped: vec![],
            },
            AppInventoryQuery::All,
            &HashSet::new(),
            &outcomes
                .into_iter()
                .enumerate()
                .map(|(app, read)| AppOutcome { app, read })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(inventory.apps.len(), 1);
        assert_eq!(inventory.apps[0].presentation, None);
        assert_eq!(inventory.skipped.len(), 1);
    }
}

#[test]
fn a_skipped_identity_root_cannot_prove_its_process_is_background() {
    use agent_desktop_core::AppPresentation::{Background, Foreground};

    for (pid, gone, windowed, expected) in [
        (8, false, false, None),
        (8, true, false, Some(Background)),
        (9, false, false, Some(Background)),
        (8, false, true, Some(Foreground)),
    ] {
        let skipped = json!({"pid": pid, "confirmed_gone": gone});
        let inventory = finish(
            Registry {
                apps: vec![app(8, "x", &[])],
                skipped: vec![skipped.clone()],
            },
            AppInventoryQuery::All,
            &if windowed {
                HashSet::from([0])
            } else {
                HashSet::new()
            },
            &[AppOutcome {
                app: 0,
                read: RootRead::Read,
            }],
        )
        .unwrap();
        assert_eq!(inventory.apps[0].presentation, expected);
        assert_eq!(inventory.skipped, [skipped]);
    }
}

#[test]
fn a_substring_match_is_not_replaced_by_an_unrelated_off_bus_diagnostic() {
    let facts = crate::system::process::process_facts::read(std::process::id()).unwrap();
    let name = crate::system::app::app_name::app_name(&facts);
    assert!(
        find_running(&name).is_some(),
        "the test process is an off-bus exact match"
    );
    let inventory = finish(
        Registry {
            apps: vec![app(8, &format!("{name}-window"), &[])],
            skipped: vec![],
        },
        AppInventoryQuery::NameOrAlias(&name),
        &HashSet::from([0]),
        &[AppOutcome {
            app: 0,
            read: RootRead::Read,
        }],
    )
    .unwrap();
    assert_eq!(inventory.apps.len(), 1);
    assert_eq!(inventory.apps[0].pid.get(), 8);
}
