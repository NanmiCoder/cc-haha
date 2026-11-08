use crate::{adapter::FixtureAdapter, fixture::Fixture};
use agent_desktop_core::{
    AppError, Deadline, LocatorMaterialization, LocatorQuery, LocatorResolution,
    LocatorResolveRequest, LocatorSelection, ObservationRoot, resolve_query,
};
use std::{hint::black_box, time::Instant};

pub(crate) struct LiveCorrectness {
    pub(crate) matches: usize,
    pub(crate) selected_refs_reresolvable: bool,
}

pub(crate) struct LiveRun {
    pub(crate) elapsed_ns: u128,
    pub(crate) correctness: LiveCorrectness,
    pub(crate) visited: u64,
    pub(crate) memo_cells: u64,
    pub(crate) dom_matches: u64,
    pub(crate) ref_count: usize,
    pub(crate) action_reads: u64,
    pub(crate) attributes_requested: u64,
    pub(crate) attribute_batches: u64,
    pub(crate) child_label_reads: u64,
    pub(crate) promotion_reads: u64,
    pub(crate) settable_reads: u64,
    pub(crate) peak_handles_owned: u64,
}

pub(crate) fn run_live_direct(
    fixture: &Fixture,
    query: &LocatorQuery,
) -> Result<LiveRun, AppError> {
    run_live(
        fixture,
        query,
        LocatorSelection::Strict,
        LocatorMaterialization::None,
    )
}

pub(crate) fn run_live_find(fixture: &Fixture, query: &LocatorQuery) -> Result<LiveRun, AppError> {
    run_live(
        fixture,
        query,
        LocatorSelection::All { limit: Some(50) },
        LocatorMaterialization::SelectedMatches,
    )
}

pub(crate) fn run_live_count(fixture: &Fixture, query: &LocatorQuery) -> Result<LiveRun, AppError> {
    run_live(
        fixture,
        query,
        LocatorSelection::Count,
        LocatorMaterialization::None,
    )
}

fn run_live(
    fixture: &Fixture,
    query: &LocatorQuery,
    selection: LocatorSelection,
    materialization: LocatorMaterialization,
) -> Result<LiveRun, AppError> {
    let request = LocatorResolveRequest {
        selection,
        deadline: Deadline::after(5_000)?,
        max_raw_depth: 50,
        surface: None,
        materialization,
    };
    let adapter = FixtureAdapter { fixture };
    let started = Instant::now();
    let resolution = resolve_query(
        &adapter,
        query,
        ObservationRoot::Window(&fixture.window),
        &request,
    )?;
    black_box((&resolution.refmap, &resolution.matches));
    let elapsed = started.elapsed().as_nanos();
    let ref_count = resolution.refmap.as_ref().map_or(0, |refmap| refmap.len());
    let selected_refs_reresolvable = selected_refs_reresolvable(fixture, &resolution);
    Ok(LiveRun {
        elapsed_ns: elapsed,
        correctness: LiveCorrectness {
            matches: resolution.meta.total_matches as usize,
            selected_refs_reresolvable,
        },
        visited: resolution.stats.traversal.nodes_visited,
        memo_cells: resolution.stats.evaluation.memo_cells_evaluated,
        dom_matches: resolution.stats.identifiers.fallback_matches,
        ref_count,
        action_reads: resolution.stats.reads.counts.action_reads,
        attributes_requested: resolution.stats.reads.counts.attributes_requested,
        attribute_batches: resolution.stats.reads.counts.attribute_batches,
        child_label_reads: resolution.stats.semantic_reads.child_label_reads,
        promotion_reads: resolution.stats.semantic_reads.promotion_reads,
        settable_reads: resolution.stats.semantic_reads.settable_reads,
        peak_handles_owned: resolution.stats.traversal.peak_handles_owned,
    })
}

fn selected_refs_reresolvable(fixture: &Fixture, resolution: &LocatorResolution) -> bool {
    let Some(refmap) = resolution.refmap.as_ref() else {
        return true;
    };
    resolution
        .matches
        .iter()
        .filter_map(|selected| selected.data.ref_id.as_deref())
        .all(|ref_id| {
            let Some(entry) = refmap.get(ref_id) else {
                return false;
            };
            fixture.nodes.iter().any(|node| {
                entry.geometry.bounds_hash == node.bounds.bounds_hash()
                    && node.role == entry.identity.role
                    && entry.identity.native_id.as_ref().map_or_else(
                        || entry.identity.name == node.name,
                        |expected| {
                            node.identifiers.0.as_deref() == Some(expected.value.as_str())
                                || node.identifiers.1.as_deref() == Some(expected.value.as_str())
                        },
                    )
            })
        })
}
