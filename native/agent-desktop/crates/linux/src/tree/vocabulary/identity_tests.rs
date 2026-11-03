use agent_desktop_core::{ElementIdentifier, IdentifierKind};

use super::identifier_evidence;
use crate::tree::Field;
use crate::tree::live::test_support::attributes;

fn id(value: &str) -> Field<String> {
    Field::Present(value.to_owned())
}

fn native(value: &str) -> ElementIdentifier {
    ElementIdentifier {
        kind: IdentifierKind::AxIdentifier,
        value: value.to_owned(),
    }
}

fn dom(value: &str) -> ElementIdentifier {
    ElementIdentifier {
        kind: IdentifierKind::AxDomIdentifier,
        value: value.to_owned(),
    }
}

#[test]
fn a_dotted_qt_id_is_kept_whole() {
    let evidence = identifier_evidence(
        &id("QApplication.mainWin.centralPane.nameEdit"),
        &attributes(&[]),
        false,
    );
    assert_eq!(
        evidence.identifiers(),
        [native("QApplication.mainWin.centralPane.nameEdit")]
    );
    assert!(evidence.is_complete());
}

#[test]
fn a_qt_id_ending_in_a_class_name_identifies_nothing() {
    let evidence = identifier_evidence(
        &id("QApplication.QMainWindow.QWidget.QPushButton"),
        &attributes(&[]),
        false,
    );
    assert!(evidence.identifiers().is_empty());
    assert!(evidence.is_complete());
    let quit = identifier_evidence(&id("QApplication.Quit"), &attributes(&[]), false);
    assert_eq!(quit.identifiers(), [native("QApplication.Quit")]);
}

#[test]
fn a_dom_id_counts_only_inside_a_web_document() {
    let attrs = attributes(&[("id", "showOnStartup"), ("tag", "div")]);
    let inside = identifier_evidence(&id(""), &attrs, true);
    assert_eq!(inside.identifiers(), [dom("showOnStartup")]);
    let outside = identifier_evidence(&id(""), &attrs, false);
    assert!(outside.identifiers().is_empty());
    assert!(outside.is_complete());
}

#[test]
fn the_dom_id_is_preferred_and_the_native_id_is_kept() {
    let attrs = attributes(&[("id", "chat")]);
    let evidence = identifier_evidence(&id("QApplication.chat"), &attrs, true);
    assert_eq!(
        evidence.identifiers(),
        [dom("chat"), native("QApplication.chat")]
    );
    assert_eq!(evidence.preferred_identifier(), Some(&dom("chat")));
}

#[test]
fn a_blank_id_is_absent_and_a_failed_read_is_unknown() {
    let blank = identifier_evidence(&id(""), &attributes(&[]), true);
    assert!(blank.identifiers().is_empty());
    assert!(blank.is_complete());
    let absent = identifier_evidence(&Field::Absent, &attributes(&[]), true);
    assert!(absent.is_complete());
    let failed = identifier_evidence(&Field::Failed("gone".to_owned()), &attributes(&[]), true);
    assert!(failed.identifiers().is_empty());
    assert!(!failed.is_complete());
    let attrs_failed = identifier_evidence(&id(""), &Field::Failed("gone".to_owned()), true);
    assert!(!attrs_failed.is_complete());
    let outside = identifier_evidence(&id(""), &Field::Failed("gone".to_owned()), false);
    assert!(outside.is_complete());
}
