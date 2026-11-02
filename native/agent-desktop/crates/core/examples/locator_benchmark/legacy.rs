use crate::{adapter::FixtureAdapter, fixture::Fixture};
use agent_desktop_core::{
    AccessibilityNode, AppError, Deadline, LocatorQuery, accessibility_node_matches, snapshot,
};
use std::{hint::black_box, time::Instant};

pub(crate) fn run_legacy(
    fixture: &Fixture,
    query: &LocatorQuery,
) -> Result<(u128, usize, u64, u64), AppError> {
    let adapter = FixtureAdapter { fixture };
    let started = Instant::now();
    let snapshot = snapshot::build(
        &adapter,
        &agent_desktop_core::TreeOptions::default(),
        Some(&fixture.window.app),
        None,
        Deadline::after(5_000)?,
    )?;
    let mut scanned = 0_u64;
    let matches = count_matches(&snapshot.tree, query, &mut scanned);
    black_box((&snapshot.refmap, matches));
    let elapsed = started.elapsed().as_nanos();
    let mut predicate_visits = 0_u64;
    instrument_predicate_visits(&snapshot.tree, query, &mut predicate_visits);
    Ok((elapsed, matches, scanned, predicate_visits))
}

fn count_matches(node: &AccessibilityNode, query: &LocatorQuery, scanned: &mut u64) -> usize {
    *scanned += 1;
    usize::from(accessibility_node_matches(node, query))
        + node
            .children
            .iter()
            .map(|child| count_matches(child, query, scanned))
            .sum::<usize>()
}

fn instrument_predicate_visits(node: &AccessibilityNode, query: &LocatorQuery, visits: &mut u64) {
    let _ = instrumented_match(node, query, visits);
    for child in &node.children {
        instrument_predicate_visits(child, query, visits);
    }
}

fn instrumented_match(node: &AccessibilityNode, query: &LocatorQuery, visits: &mut u64) -> bool {
    *visits += 1;
    if !identity_matches(node, query) {
        return false;
    }
    if let Some(expected) = query.has_text.as_deref() {
        if !node_text_matches(node, expected) && !descendant_text_matches(node, expected, visits) {
            return false;
        }
    }
    if let Some(has) = query.containment.has.as_deref() {
        if !descendant_query_matches(node, has, visits) {
            return false;
        }
    }
    if let Some(has_not) = query.containment.has_not.as_deref() {
        if descendant_query_matches(node, has_not, visits) {
            return false;
        }
    }
    true
}

fn identity_matches(node: &AccessibilityNode, query: &LocatorQuery) -> bool {
    query
        .identity
        .role
        .as_deref()
        .is_none_or(|expected| normalized(&node.role) == expected)
        && field_matches(
            query.identity.name.as_deref(),
            node.identity.name.as_deref(),
            query.exact,
        )
        && query.identity.native_id.as_deref().is_none_or(|expected| {
            node.identity
                .native_id
                .as_ref()
                .is_some_and(|actual| actual.value == expected)
        })
}

fn field_matches(expected: Option<&str>, actual: Option<&str>, exact: bool) -> bool {
    let Some(expected) = expected else {
        return true;
    };
    let Some(actual) = actual else {
        return false;
    };
    let actual = normalized(actual);
    if exact {
        actual == expected
    } else {
        actual.contains(expected)
    }
}

fn descendant_text_matches(node: &AccessibilityNode, expected: &str, visits: &mut u64) -> bool {
    for child in &node.children {
        *visits += 1;
        if node_text_matches(child, expected) || descendant_text_matches(child, expected, visits) {
            return true;
        }
    }
    false
}

fn descendant_query_matches(
    node: &AccessibilityNode,
    query: &LocatorQuery,
    visits: &mut u64,
) -> bool {
    node.children.iter().any(|child| {
        instrumented_match(child, query, visits) || descendant_query_matches(child, query, visits)
    })
}

fn node_text_matches(node: &AccessibilityNode, expected: &str) -> bool {
    [
        node.identity.name.as_deref(),
        node.identity.description.as_deref(),
        node.identity.value.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|value| normalized(value).contains(expected))
}

fn normalized(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
