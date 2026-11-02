use agent_desktop_core::{ElementIdentifier, IdentifierEvidence, IdentifierKind};

use crate::tree::Field;
use crate::tree::properties::attributes::{AttributeRead, non_blank};

fn looks_like_a_qt_class(segment: &str) -> bool {
    let mut characters = segment.chars();
    characters.next() == Some('Q')
        && characters
            .next()
            .is_some_and(|character| character.is_ascii_uppercase())
}

fn is_identifying(accessible_id: &str) -> bool {
    let last = accessible_id
        .rsplit_once('.')
        .map_or(accessible_id, |(_, last)| last);
    !looks_like_a_qt_class(last)
}

fn native_identifier(accessible_id: &Field<String>) -> (Option<ElementIdentifier>, bool) {
    match accessible_id {
        Field::Present(value) => {
            let value = value.trim();
            let identifier =
                (!value.is_empty() && is_identifying(value)).then(|| ElementIdentifier {
                    kind: IdentifierKind::AxIdentifier,
                    value: value.to_owned(),
                });
            (identifier, true)
        }
        Field::Absent => (None, true),
        Field::Failed(_) => (None, false),
    }
}

fn dom_identifier(
    attributes: &AttributeRead,
    in_web_document: bool,
) -> (Option<ElementIdentifier>, bool) {
    if !in_web_document {
        return (None, true);
    }
    match non_blank(attributes, "id") {
        Some(value) => (
            Some(ElementIdentifier {
                kind: IdentifierKind::AxDomIdentifier,
                value: value.to_owned(),
            }),
            true,
        ),
        None => (None, !attributes.is_failed()),
    }
}

/// The developer identifiers of a node. Qt's `AccessibleId` is kept whole
/// unless its last segment is a Qt class name, which names the widget's type
/// and identifies nothing. The DOM `id` counts only inside a web document,
/// because browser chrome carries view ids under the same key, and is the
/// preferred identifier when both exist. A node with none is answered-absent;
/// a failed read leaves the evidence incomplete.
pub(crate) fn identifier_evidence(
    accessible_id: &Field<String>,
    attributes: &AttributeRead,
    in_web_document: bool,
) -> IdentifierEvidence {
    let (dom, dom_complete) = dom_identifier(attributes, in_web_document);
    let (native, native_complete) = native_identifier(accessible_id);
    let found: Vec<ElementIdentifier> = dom.into_iter().chain(native).collect();
    let preferred = if found.is_empty() { None } else { Some(0) };
    IdentifierEvidence::typed(found, preferred, dom_complete && native_complete)
}

#[cfg(test)]
#[path = "identity_tests.rs"]
mod tests;
