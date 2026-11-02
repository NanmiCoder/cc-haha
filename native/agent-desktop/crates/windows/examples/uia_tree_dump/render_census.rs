use agent_desktop_core::tree::roles::INTERACTIVE_ROLES;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// One row per `ControlType` the target exposes, carrying what the vocabulary
/// made of it.
///
/// This is what a reviewer reads to judge whether the map is right: the
/// control type on the left, the canonical role beside it, and the distinct
/// action lists and state tokens observed under it. A full per-node dump
/// carried the same information a hundred times over - measured on Explorer,
/// 100 nodes across 23 control types with 85 of 100 provider strings verbatim
/// repeats and every bounds value unassertable by rule.
pub fn control_type_census(nodes: &[Value]) -> Value {
    let mut rows: BTreeMap<String, Row> = BTreeMap::new();
    for node in nodes {
        let row = rows.entry(node["control_type"].to_string()).or_default();
        row.absorb(node);
    }
    Value::Array(
        rows.into_iter()
            .map(|(control_type, row)| row.render(&control_type))
            .collect(),
    )
}

/// The four "how much of this row's identity evidence is non-blank" counters,
/// grouped so `Row` stays under the project's field-count cap.
#[derive(Default)]
struct Coverage {
    automation_id: usize,
    name: usize,
    description: usize,
    label: usize,
    subrole: usize,
    role_description: usize,
    placeholder: usize,
}

#[derive(Default)]
struct Row {
    nodes: usize,
    class_names: BTreeSet<String>,
    roles: BTreeSet<String>,
    action_lists: BTreeSet<String>,
    state_tokens: BTreeSet<String>,
    coverage: Coverage,
}

impl Row {
    fn absorb(&mut self, node: &Value) {
        self.nodes += 1;
        self.class_names.insert(node["class_name"].to_string());
        self.roles.insert(node["role"].to_string());
        self.action_lists
            .insert(node["available_actions"].to_string());
        if let Some(states) = node["states"].as_array() {
            for token in states {
                self.state_tokens.insert(token.to_string());
            }
        }
        self.coverage.automation_id += usize::from(is_present(&node["automation_id"]));
        self.coverage.name += usize::from(is_present(&node["name"]));
        self.coverage.description += usize::from(is_present(&node["description"]));
        self.coverage.label += usize::from(node["labelled"].as_bool().unwrap_or(false));
        self.coverage.subrole += usize::from(is_present(&node["subrole"]));
        self.coverage.role_description += usize::from(is_present(&node["role_description"]));
        self.coverage.placeholder += usize::from(is_present(&node["placeholder"]));
    }

    fn render(self, control_type: &str) -> Value {
        json!({
            "control_type": control_type,
            "nodes": self.nodes,
            "roles": self.roles.into_iter().collect::<Vec<_>>(),
            "class_names": self.class_names.into_iter().collect::<Vec<_>>(),
            "action_lists": self.action_lists.into_iter().collect::<Vec<_>>(),
            "state_tokens": self.state_tokens.into_iter().collect::<Vec<_>>(),
            "with_non_blank_automation_id": self.coverage.automation_id,
            "with_non_blank_name": self.coverage.name,
            "with_description": self.coverage.description,
            "with_label_relation": self.coverage.label,
            "with_subrole": self.coverage.subrole,
            "with_role_description": self.coverage.role_description,
            "with_placeholder": self.coverage.placeholder,
        })
    }
}

/// Whether a presence-and-length slot recorded actual content.
///
/// The rule is **non-blank**, not merely present. An earlier census counted
/// `automation_id != "<absent>"`, so a `Known("")` counted toward coverage -
/// which overstates it and is not comparable with A7-1's measured percentages.
/// This matches `element_properties.rs`'s own blank filter and
/// `IdentifierEvidence::typed`'s.
fn is_present(slot: &Value) -> bool {
    slot["chars"].as_u64().unwrap_or(0) > 0
}

/// The summary a reviewer reads before the rows: how much of this target the
/// vocabulary actually understood.
pub fn vocabulary_summary(nodes: &[Value]) -> Value {
    let resolved = nodes
        .iter()
        .filter(|node| node["role"].as_str() != Some("unknown"))
        .count();
    let mut unresolved: BTreeSet<String> = BTreeSet::new();
    let mut produced: BTreeSet<String> = BTreeSet::new();
    let mut with_actions = 0;
    let mut with_states = 0;
    for node in nodes {
        match node["role"].as_str() {
            Some("unknown") => {
                unresolved.insert(node["control_type"].to_string());
            }
            Some(role) if INTERACTIVE_ROLES.contains(&role) => {
                produced.insert(role.to_string());
            }
            _ => {}
        }
        with_actions += usize::from(
            node["available_actions"]
                .as_array()
                .is_some_and(|actions| !actions.is_empty()),
        );
        with_states += usize::from(
            node["states"]
                .as_array()
                .is_some_and(|states| !states.is_empty()),
        );
    }
    json!({
        "identifier_coverage_rule": "non-blank, matching IdentifierEvidence::typed - not merely present",
        "nodes": nodes.len(),
        "resolved_to_a_role": resolved,
        "control_types_resolving_to_unknown": unresolved.into_iter().collect::<Vec<_>>(),
        "interactive_roles_produced": produced.into_iter().collect::<Vec<_>>(),
        "nodes_advertising_an_action": with_actions,
        "nodes_carrying_a_state": with_states,
        "non_blank_automation_id": nodes.iter().filter(|node| is_present(&node["automation_id"])).count(),
        "non_blank_name": nodes.iter().filter(|node| is_present(&node["name"])).count(),
    })
}

/// One row per distinct provider, which is what the cache policy keys on.
pub fn provider_census(nodes: &[Value]) -> Value {
    let mut rows: BTreeMap<String, usize> = BTreeMap::new();
    for node in nodes {
        *rows
            .entry(node["provider_description"].to_string())
            .or_default() += 1;
    }
    Value::Array(
        rows.into_iter()
            .map(|(provider, count)| json!({ "provider": provider, "nodes": count }))
            .collect(),
    )
}

/// One fully-detailed node per control type, so the shape stays inspectable
/// without repeating it for every sibling.
pub fn sample(nodes: &[Value]) -> Value {
    let mut seen = BTreeSet::new();
    Value::Array(
        nodes
            .iter()
            .filter(|node| seen.insert(node["control_type"].to_string()))
            .cloned()
            .collect(),
    )
}
