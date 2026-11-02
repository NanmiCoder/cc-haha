use super::{
    LocatorField, LocatorMatch, LocatorMaterialization, LocatorResolution, LocatorResolutionMeta,
    LocatorResolveRequest, ObservedTree,
    compiled_clause::{CompiledClause, compile_clauses},
    evaluation_buffers::EvaluationBuffers,
    match_verdict::MatchVerdict,
    materialize::{materialize_refmap, ref_entry},
    predicate::{normalize_query, self_text_verdict, self_verdict},
    select::{match_data, selected_indices},
    selection_completeness::first_is_authoritative,
    validate::{validate_query, validate_request},
};
use crate::{AdapterError, locator::LocatorQuery};
use std::collections::BTreeSet;

pub fn evaluate_locator_tree(
    mut tree: ObservedTree,
    query: &LocatorQuery,
    request: &LocatorResolveRequest,
) -> Result<LocatorResolution, AdapterError> {
    validate_query(query)?;
    validate_request(request)?;
    let normalized = normalize_query(query);
    let mut clauses = Vec::new();
    let root_clause = compile_clauses(&normalized, &mut clauses);
    let mut parents = vec![None; tree.nodes.len()];
    for (index, node) in tree.nodes.iter().enumerate() {
        for child in &node.children {
            parents[*child as usize] = Some(index);
        }
    }
    let cells = tree
        .nodes
        .len()
        .checked_mul(clauses.len())
        .ok_or_else(|| AdapterError::internal("locator evaluation matrix is too large"))?;
    let mut matches = vec![MatchVerdict::NoMatch; cells];
    let mut subtree_matches = vec![MatchVerdict::NoMatch; cells];
    let mut subtree_text = vec![MatchVerdict::NoMatch; cells];
    let mut stats = std::mem::take(&mut tree.stats);
    stats.evaluation.query_clause_count = clauses.len() as u32;
    stats.evaluation.text_clause_count = clauses
        .iter()
        .filter(|clause| clause.query.has_text.is_some())
        .count() as u32;

    {
        let mut buffers = EvaluationBuffers {
            matches: matches.as_mut_slice(),
            subtree_matches: subtree_matches.as_mut_slice(),
            subtree_text: subtree_text.as_mut_slice(),
            stats: &mut stats,
        };
        for node_index in (0..tree.nodes.len()).rev() {
            evaluate_node(&tree, node_index, &clauses, &mut buffers);
        }
    }

    let mut matched_indices = Vec::new();
    let mut unknown = false;
    for index in 0..tree.nodes.len() {
        match matches[cell(index, root_clause, clauses.len())] {
            MatchVerdict::Match => matched_indices.push(index),
            MatchVerdict::Unknown => unknown = true,
            MatchVerdict::NoMatch => {}
        }
    }
    stats.evaluation.matched_nodes = matched_indices.len() as u64;
    let (selected, truncated) = selected_indices(&matched_indices, request.selection);
    let mut complete = tree.structurally_complete && !unknown;
    let refmap = match request.materialization {
        LocatorMaterialization::None => None,
        LocatorMaterialization::SelectedMatches => {
            let (refmap, materialization_complete) =
                materialize_refmap(&mut tree, &normalized, Some(&selected))?;
            complete &= materialization_complete;
            Some(refmap)
        }
        LocatorMaterialization::FullRefMap => {
            let (refmap, materialization_complete) =
                materialize_refmap(&mut tree, &normalized, None)?;
            complete &= materialization_complete;
            Some(refmap)
        }
    };
    let mut selected_matches = Vec::with_capacity(selected.len());
    for index in selected {
        let data = match_data(&tree, index, &parents)
            .ok_or_else(|| AdapterError::internal("selected locator node is missing"))?;
        let node = tree
            .nodes
            .get(index)
            .ok_or_else(|| AdapterError::internal("selected locator node is out of bounds"))?;
        let entry = ref_entry(node, &tree.source, &normalized);
        selected_matches.push(LocatorMatch {
            data,
            document_order: node.document_order,
            screen_bounds: super::materialize::screen_bounds(&node.evidence),
            fully_observed: super::materialize::fully_observed(
                &node.evidence,
                entry.geometry.bounds_space.unwrap_or_default(),
            ),
            entry,
        });
    }
    let roles_present = if matched_indices.is_empty() {
        tree.nodes
            .iter()
            .filter_map(|node| match &node.evidence.role {
                LocatorField::Known(role) => Some(role.clone()),
                LocatorField::Absent | LocatorField::Unknown => None,
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    } else {
        Vec::new()
    };
    let total_matches = u32::try_from(matched_indices.len())
        .map_err(|_| AdapterError::internal("locator match count exceeds u32"))?;
    let selection_complete = complete || {
        matches!(request.selection, super::LocatorSelection::First)
            && selected_matches.first().is_some_and(|selected| {
                let root_verdicts = (0..tree.nodes.len())
                    .map(|index| matches[cell(index, root_clause, clauses.len())])
                    .collect::<Vec<_>>();
                first_is_authoritative(
                    &tree,
                    selected.document_order as usize,
                    &parents,
                    &root_verdicts,
                )
            })
    };
    Ok(LocatorResolution {
        matches: selected_matches,
        refmap,
        stats,
        meta: LocatorResolutionMeta {
            total_matches,
            complete,
            selection_complete,
            truncated,
            roles_present,
        },
    })
}

fn evaluate_node(
    tree: &ObservedTree,
    node_index: usize,
    clauses: &[CompiledClause<'_>],
    buffers: &mut EvaluationBuffers<'_>,
) {
    let Some(node) = tree.nodes.get(node_index) else {
        return;
    };
    for (clause_index, clause) in clauses.iter().enumerate() {
        let offset = cell(node_index, clause_index, clauses.len());
        let own = self_verdict(clause.query, &node.evidence, &mut buffers.stats.identifiers);
        if own != MatchVerdict::NoMatch {
            buffers.stats.evaluation.self_filter_candidates += 1;
        }
        let text = if clause.query.has_text.is_some() {
            buffers.stats.evaluation.memo_cells_evaluated += 1;
            aggregate_subtree(
                tree,
                node_index,
                (clause_index, clauses.len()),
                self_text_verdict(
                    clause.query.has_text.as_deref(),
                    &node.evidence,
                    clause.query.exact,
                ),
                buffers.subtree_text,
            )
        } else {
            MatchVerdict::Match
        };
        buffers.subtree_text[offset] = text;
        let has = clause
            .has
            .map(|nested| {
                aggregate_descendants(
                    tree,
                    node_index,
                    nested,
                    clauses.len(),
                    buffers.subtree_matches,
                )
            })
            .unwrap_or(MatchVerdict::Match);
        let has_not = clause
            .has_not
            .map(|nested| {
                aggregate_descendants(
                    tree,
                    node_index,
                    nested,
                    clauses.len(),
                    buffers.subtree_matches,
                )
                .negate()
            })
            .unwrap_or(MatchVerdict::Match);
        let verdict = own.and(text).and(has).and(has_not);
        buffers.matches[offset] = verdict;
        buffers.subtree_matches[offset] = aggregate_subtree(
            tree,
            node_index,
            (clause_index, clauses.len()),
            verdict,
            buffers.subtree_matches,
        );
        buffers.stats.evaluation.memo_cells_evaluated += 2;
    }
}

fn aggregate_descendants(
    tree: &ObservedTree,
    node_index: usize,
    clause_index: usize,
    clause_count: usize,
    matrix: &[MatchVerdict],
) -> MatchVerdict {
    let Some(node) = tree.nodes.get(node_index) else {
        return MatchVerdict::Unknown;
    };
    let mut verdict = MatchVerdict::NoMatch;
    for child in &node.children {
        verdict = verdict.or(matrix[cell(*child as usize, clause_index, clause_count)]);
    }
    if verdict == MatchVerdict::NoMatch && !node.completeness.subtree_complete {
        MatchVerdict::Unknown
    } else {
        verdict
    }
}

fn aggregate_subtree(
    tree: &ObservedTree,
    node_index: usize,
    clause: (usize, usize),
    own: MatchVerdict,
    matrix: &[MatchVerdict],
) -> MatchVerdict {
    let Some(node) = tree.nodes.get(node_index) else {
        return MatchVerdict::Unknown;
    };
    let mut verdict = own;
    for child in &node.children {
        verdict = verdict.or(matrix[cell(*child as usize, clause.0, clause.1)]);
    }
    if verdict == MatchVerdict::NoMatch && !node.completeness.subtree_complete {
        MatchVerdict::Unknown
    } else {
        verdict
    }
}

fn cell(node: usize, clause: usize, clause_count: usize) -> usize {
    node * clause_count + clause
}
