use agent_desktop_core::{Deadline, LocatorField, tree::state};
use zbus::Connection as AsyncConnection;

use super::live_tree::{count_failed, failure_kinds};
use super::walker_live_tests::{Settled, settle_watching};
use crate::system::SharedBus;
use crate::tree::vocabulary::role_numbers::{DOCUMENT_FRAME, DOCUMENT_WEB};
use crate::tree::{
    AtspiElement, LabelOutcome, ObservedRead, RawNode, ResolvedVocabulary, WalkedNode, read_label,
    resolve_vocabulary,
};

pub(in crate::tree) struct Entry {
    pub(in crate::tree) node: RawNode,
    pub(in crate::tree) in_web: bool,
    pub(in crate::tree) vocabulary: ResolvedVocabulary,
    pub(in crate::tree) label: LabelOutcome,
}

pub(in crate::tree) struct Analysis {
    pub(in crate::tree) label: &'static str,
    pub(in crate::tree) entries: Vec<Entry>,
}

fn flatten(node: &WalkedNode<ObservedRead>, in_web: bool, out: &mut Vec<(RawNode, bool)>) {
    out.push((node.payload.node.clone(), in_web));
    let role = node.payload.node.traits.role.present().copied();
    let below = in_web || matches!(role, Some(DOCUMENT_WEB | DOCUMENT_FRAME));
    for child in &node.children {
        flatten(child, below, out);
    }
}

pub(in crate::tree) fn name_is_blank(node: &RawNode) -> bool {
    node.properties
        .name
        .present()
        .is_none_or(|name| name.trim().is_empty())
}

fn analyze(label: &'static str, connection: &AsyncConnection, settled: &Settled) -> Analysis {
    let mut flat = Vec::new();
    flatten(&settled.walk.root, false, &mut flat);
    let mut entries = Vec::with_capacity(flat.len());
    for (node, in_web) in flat {
        let outcome = if name_is_blank(&node) {
            zbus::block_on(read_label(connection, &node.element)).expect("label read")
        } else {
            LabelOutcome::Unlabelled
        };
        let vocabulary = resolve_vocabulary(&node, &outcome, in_web);
        entries.push(Entry {
            node,
            in_web,
            vocabulary,
            label: outcome,
        });
    }
    Analysis { label, entries }
}

pub(in crate::tree) fn token(field: &LocatorField<String>) -> String {
    match field {
        LocatorField::Known(value) => value.clone(),
        LocatorField::Absent => "<absent>".to_owned(),
        LocatorField::Unknown => "<unknown>".to_owned(),
    }
}

pub(in crate::tree) fn is_disabled(entry: &Entry) -> bool {
    matches!(&entry.vocabulary.states, LocatorField::Known(tokens) if tokens.iter().any(|t| t == state::DISABLED))
}

fn check_common(analysis: &Analysis) -> Result<(), String> {
    let mut problems = Vec::new();
    for entry in &analysis.entries {
        let vocabulary = &entry.vocabulary;
        let label = analysis.label;
        if vocabulary.role.is_unknown() {
            problems.push(format!("{label}: unknown role"));
        }
        match &vocabulary.states {
            LocatorField::Known(tokens) => state::assert_states_in_vocabulary(tokens),
            _ => problems.push(format!("{label}: unknown states")),
        }
        if vocabulary.name.is_unknown() {
            problems.push(format!("{label}: unknown name"));
        }
        if !vocabulary.identifiers.is_complete() {
            problems.push(format!("{label}: incomplete identifiers"));
        }
    }
    problems.dedup();
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

pub(in crate::tree) fn root_is_window(analysis: &Analysis) -> Result<(), String> {
    let root = &analysis.entries[0].vocabulary.role;
    if *root == LocatorField::Known("window".to_owned()) {
        Ok(())
    } else {
        Err(format!("{}: top-level frame is {root:?}", analysis.label))
    }
}

pub(in crate::tree) fn walk(
    bus: &SharedBus,
    label: &'static str,
    min_nodes: usize,
    watched: Option<u32>,
    find: impl FnMut() -> Option<AtspiElement>,
) -> Result<(Settled, Analysis), String> {
    let settled = settle_watching(bus, min_nodes, watched, find)
        .map_err(|error| format!("{label}: {error}"))?;
    let deadline = Deadline::standard().map_err(|error| error.message)?;
    let connection = bus.get(deadline).map_err(|error| error.message)?;
    let analysis = analyze(label, connection.inner(), &settled);
    if !settled.walk.complete {
        return Err(format!("{label}: walk incomplete"));
    }
    let failed = count_failed(&settled.walk.root);
    if failed > 0 {
        for kind in failure_kinds(&settled.walk.root) {
            println!("vocabulary_live {label} read error: {kind}");
        }
        return Err(format!("{label}: {failed} failed reads"));
    }
    check_common(&analysis).map_err(|problem| format!("{label}: {problem}"))?;
    Ok((settled, analysis))
}
