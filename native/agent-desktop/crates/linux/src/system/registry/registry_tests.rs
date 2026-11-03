use std::cell::Cell;

use super::{AppRead, AppReads, read_known};
use crate::system::process::process_facts::ProcessFacts;
use crate::system::process::toolkit_id::ToolkitId;
use crate::tree::AtspiElement;

fn facts(instance: &str) -> ProcessFacts {
    ProcessFacts {
        executable: None,
        comm: "x".into(),
        exe_basename: Some("x".into()),
        instance: instance.into(),
    }
}

#[derive(Default)]
struct Counting {
    next: Option<super::Lookup>,
    stopped: bool,
    remembered: Option<String>,
    saved: std::cell::RefCell<Vec<String>>,
    facts: Cell<u32>,
    names: Cell<u32>,
    toolkits: Cell<u32>,
}

impl AppReads for Counting {
    fn facts(&self, _pid: u32) -> super::Lookup {
        self.facts.set(self.facts.get() + 1);
        if self.facts.get() > 1
            && let Some(next) = &self.next
        {
            return next.clone();
        }
        super::Lookup::Found(facts("boot:1"))
    }

    fn is_stopped(&self, _pid: u32) -> bool {
        self.stopped
    }

    async fn name(&self, _root: &AtspiElement) -> Option<Option<String>> {
        self.names.set(self.names.get() + 1);
        Some(Some("App".to_owned()))
    }

    async fn toolkit(&self, _root: &AtspiElement) -> ToolkitId {
        self.toolkits.set(self.toolkits.get() + 1);
        ToolkitId::default()
    }

    fn remembered_name(&self, _root: &AtspiElement, _instance: &str) -> Option<String> {
        self.remembered.clone()
    }

    fn remember_name(&self, _root: &AtspiElement, _instance: &str, name: &str) {
        self.saved.borrow_mut().push(name.to_owned());
    }
}

#[test]
fn a_process_replaced_during_root_enrichment_is_incomplete_not_a_live_candidate() {
    let reads = Counting {
        next: Some(super::Lookup::Found(facts("boot:2"))),
        ..Counting::default()
    };
    let AppRead::Skipped(record) = read(&reads, 7, None) else {
        panic!("a replaced process must not authorize an app lookup")
    };
    assert_eq!(record["pid"], 7);
    assert!(record["reason"].as_str().unwrap().contains("changed"));
}

fn root(pid: u32) -> AtspiElement {
    AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/root", pid)
}

fn read(reads: &Counting, pid: u32, only: Option<u32>) -> AppRead {
    zbus::block_on(read_known(
        reads,
        root(pid),
        &super::app_query::AppQuery {
            pid: only,
            select: &|_| true,
            enrich: true,
        },
    ))
}

#[test]
fn a_process_filter_never_reads_a_non_matching_pids_facts_name_or_toolkit() {
    let reads = Counting::default();
    assert!(matches!(read(&reads, 7, Some(8)), AppRead::Excluded));
    assert_eq!(
        (reads.facts.get(), reads.names.get(), reads.toolkits.get()),
        (0, 0, 0)
    );
}

#[test]
fn a_process_filter_reads_the_matching_pid_in_full() {
    let reads = Counting::default();
    assert!(matches!(read(&reads, 8, Some(8)), AppRead::Listed(_)));
    assert_eq!(
        (reads.facts.get(), reads.names.get(), reads.toolkits.get()),
        (2, 1, 1)
    );
}

#[test]
fn an_unrelated_running_root_is_not_enriched_by_a_name_or_alias_query() {
    let reads = Counting::default();
    let select = |app: &super::RegistryApp| {
        crate::system::context::inventory::matches(
            agent_desktop_core::AppInventoryQuery::NameOrAlias("other"),
            app,
        )
    };
    let result = zbus::block_on(read_known(
        &reads,
        root(8),
        &super::app_query::AppQuery {
            pid: None,
            select: &select,
            enrich: true,
        },
    ));
    assert!(matches!(result, AppRead::Excluded));
    assert_eq!((reads.names.get(), reads.toolkits.get()), (0, 0));
    assert_eq!(reads.facts.get(), 1, "process identity is still examined");
}

#[test]
fn launch_owner_inventory_reads_no_ui_metadata() {
    let reads = Counting::default();
    let result = zbus::block_on(read_known(
        &reads,
        root(8),
        &super::app_query::AppQuery {
            pid: None,
            select: &|_| true,
            enrich: false,
        },
    ));
    let AppRead::Listed(app) = result else {
        panic!("process owner retained")
    };
    assert_eq!(app.facts.instance, "boot:1");
    assert_eq!((reads.names.get(), reads.toolkits.get()), (0, 0));
}

#[test]
fn a_stopped_process_is_listed_unanswered_without_a_name_or_toolkit_read() {
    let reads = Counting {
        stopped: true,
        ..Counting::default()
    };
    let AppRead::Listed(app) = read(&reads, 7, None) else {
        panic!("a stopped app stays listed")
    };
    assert!(!app.answered);
    assert_eq!(reads.facts.get(), 2);
    assert_eq!((reads.names.get(), reads.toolkits.get()), (0, 0));
}

#[test]
fn a_running_process_is_read_for_its_name_and_toolkit() {
    let reads = Counting::default();
    let AppRead::Listed(app) = read(&reads, 7, None) else {
        panic!("listed")
    };
    assert!(app.answered);
    assert_eq!((reads.names.get(), reads.toolkits.get()), (1, 1));
    assert_eq!(reads.saved.borrow().as_slice(), ["App"]);
}

#[test]
fn a_stopped_process_keeps_its_registry_label_without_using_it_as_identity() {
    let reads = Counting {
        stopped: true,
        remembered: Some("QtApp".to_owned()),
        ..Counting::default()
    };
    let AppRead::Listed(app) = read(&reads, 7, None) else {
        panic!("a stopped app stays listed")
    };
    assert!(!app.answered);
    assert_eq!(app.registry_name.as_deref(), Some("QtApp"));
    assert!(!app.matches("qtapp"));
    assert!(app.matches("x"));
    assert!(!app.matches("unknown-app"));
    assert_eq!((reads.names.get(), reads.toolkits.get()), (0, 0));
}

#[test]
fn a_confirmed_exit_during_enrichment_remains_positive_absence() {
    for next in [super::Lookup::Gone, super::Lookup::Unreadable] {
        let reads = Counting {
            next: Some(next.clone()),
            ..Counting::default()
        };
        let AppRead::Skipped(record) = read(&reads, 7, None) else {
            panic!("no live candidate")
        };
        assert_eq!(
            record["confirmed_gone"].as_bool(),
            (next == super::Lookup::Gone).then_some(true)
        );
    }
}
