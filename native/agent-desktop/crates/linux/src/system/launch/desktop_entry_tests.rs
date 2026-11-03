use super::*;

const CALCULATOR: &str = "\
[Desktop Entry]
Name=Calculator
Name[de]=Rechner
Type=Application
Exec=gnome-calculator
TryExec=gnome-calculator
Icon=org.gnome.Calculator
StartupWMClass=Gnome-calculator
Path=/tmp

[Desktop Action new]
Name=New
Exec=other
";

#[test]
fn the_launching_fields_are_read_from_the_main_group_only() {
    let entry = parse("org.gnome.Calculator", CALCULATOR).expect("entry");
    assert_eq!(entry.id, "org.gnome.Calculator");
    assert_eq!(entry.name, "Calculator");
    assert_eq!(entry.exec.as_deref(), Some("gnome-calculator"));
    assert_eq!(entry.try_exec.as_deref(), Some("gnome-calculator"));
    assert_eq!(entry.path.as_deref(), Some("/tmp"));
    assert_eq!(entry.icon.as_deref(), Some("org.gnome.Calculator"));
    assert!(entry.traits.application);
    assert!(!entry.traits.terminal && !entry.traits.hidden);
    assert_eq!(entry.traits.wm_class.as_deref(), Some("Gnome-calculator"));
}

#[test]
fn the_first_occurrence_of_a_key_wins() {
    let text = "[Desktop Entry]\nName=First\nName=Second\n";
    assert_eq!(parse("x", text).expect("entry").name, "First");
}

#[test]
fn text_without_the_group_or_a_name_is_not_an_entry() {
    assert!(parse("x", "[Other]\nName=A\n").is_none());
    assert!(parse("x", "[Desktop Entry]\nExec=a\n").is_none());
    assert!(parse("x", "").is_none());
}

#[test]
fn value_escapes_are_undone_once() {
    let text = "[Desktop Entry]\nName=A\\sB\nExec=a \\\\ b\n";
    let entry = parse("x", text).expect("entry");
    assert_eq!(entry.name, "A B");
    assert_eq!(entry.exec.as_deref(), Some("a \\ b"));
}
