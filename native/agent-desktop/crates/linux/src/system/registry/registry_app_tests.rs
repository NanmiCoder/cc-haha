use super::*;

fn facts() -> ProcessFacts {
    ProcessFacts {
        executable: None,
        comm: "gnome-calculato".to_owned(),
        exe_basename: Some("gnome-calculator".to_owned()),
        instance: "boot:42".to_owned(),
    }
}

fn root() -> AtspiElement {
    AtspiElement::new(":1.9", "/org/a11y/atspi/accessible/root", 321)
}

#[test]
fn a_stopped_app_that_never_answers_is_kept_and_named_from_proc() {
    let app = assemble(root(), facts(), None, ToolkitId::default());
    assert!(!app.answered);
    assert_eq!(app.name, "gnome-calculator");
    assert_eq!(app.root.pid(), 321);
    assert_eq!(app.facts.instance, "boot:42");
}

fn nautilus_facts() -> ProcessFacts {
    ProcessFacts {
        executable: None,
        comm: "nautilus".to_owned(),
        exe_basename: Some("nautilus".to_owned()),
        instance: "boot:7".to_owned(),
    }
}

#[test]
fn the_listed_name_is_identical_whether_the_root_answers_or_the_app_is_stopped() {
    let answering = assemble(
        root(),
        nautilus_facts(),
        Some(Some("org.gnome.Nautilus".to_owned())),
        ToolkitId::default(),
    );
    let stopped = assemble(root(), nautilus_facts(), None, ToolkitId::default());
    assert!(answering.answered);
    assert!(!stopped.answered);
    assert_eq!(answering.name, "nautilus");
    assert_eq!(answering.name, stopped.name);
}

#[test]
fn registry_labels_do_not_select_apps_without_verified_aliases() {
    let mut answering = assemble(
        root(),
        nautilus_facts(),
        Some(Some("org.gnome.Nautilus".to_owned())),
        ToolkitId::default(),
    );
    answering.aliases.clear();
    let mut stopped = assemble(root(), nautilus_facts(), None, ToolkitId::default());
    stopped.aliases.clear();
    assert!(!answering.matches("org.gnome.Nautilus"));
    assert!(!stopped.matches("org.gnome.Nautilus"));
    assert!(answering.matches("nautilus"));
    assert!(stopped.matches("nautilus"));
}

#[test]
fn a_desktop_id_alias_finds_an_app_whose_root_reports_another_registry_name() {
    let mut app = assemble(
        root(),
        nautilus_facts(),
        Some(Some("nautilus".to_owned())),
        ToolkitId::default(),
    );
    app.aliases = vec!["org.gnome.Nautilus".to_owned()];
    assert!(app.matches("org.gnome.Nautilus"));
}

#[test]
fn an_app_that_answers_with_a_blank_name_has_no_registry_name() {
    let app = assemble(
        root(),
        facts(),
        Some(Some("  ".to_owned())),
        ToolkitId::default(),
    );
    assert!(app.answered);
    assert_eq!(app.registry_name, None);
    assert_eq!(app.name, "gnome-calculator");
}
