use crate::{fixture::Fixture, fixture_node::FixtureNode};
use agent_desktop_core::{
    AdapterError, ElementIdentifier, EvidenceRequirements, IdentifierEvidence, IdentifierKind,
    LocatorEvidence, LocatorField, LocatorIdentifierStats, LocatorReadCounts, LocatorReadStats,
    LocatorRefEvidence, LocatorSemanticReadStats, LocatorStats, LocatorTraversalStats,
    ObservationRequest, ObservationSource, ObservedSubtree, ObservedTree,
};

pub(crate) fn live_tree(
    fixture: &Fixture,
    requirements: EvidenceRequirements,
) -> Result<ObservedTree, AdapterError> {
    live_tree_from_roots(
        fixture,
        &fixture.roots,
        ObservationSource::Window {
            window: fixture.window.clone(),
            surface: agent_desktop_core::SnapshotSurface::Window,
        },
        requirements,
    )
}

pub(crate) fn live_tree_from_roots(
    fixture: &Fixture,
    root_indices: &[u32],
    source: ObservationSource,
    requirements: EvidenceRequirements,
) -> Result<ObservedTree, AdapterError> {
    let roots = root_indices
        .iter()
        .map(|root| live_node(fixture, *root, requirements))
        .collect::<Result<Vec<_>, _>>()?;
    let observed_indices = reachable_indices(fixture, root_indices)?;
    ObservedTree::from_roots(
        roots,
        source,
        stats_for_indices(fixture, &observed_indices, requirements),
        true,
    )
}

pub(crate) fn live_target_tree(
    fixture: &Fixture,
    index: u32,
    source: ObservationSource,
    request: &ObservationRequest,
) -> Result<ObservedTree, AdapterError> {
    let mut reads = Vec::new();
    let root = live_target_node(fixture, index, request, 0, &mut reads)?;
    ObservedTree::from_roots(vec![root], source, stats_for_reads(fixture, &reads), true)
}

fn live_target_node(
    fixture: &Fixture,
    index: u32,
    request: &ObservationRequest,
    raw_depth: u8,
    reads: &mut Vec<(usize, EvidenceRequirements)>,
) -> Result<ObservedSubtree, AdapterError> {
    let node = fixture
        .nodes
        .get(index as usize)
        .ok_or_else(|| AdapterError::internal("benchmark fixture index is out of bounds"))?;
    let requirements = request.evidence_for_raw_depth(raw_depth);
    reads.push((index as usize, requirements));
    let at_boundary = raw_depth >= request.max_logical_depth || raw_depth >= request.max_raw_depth;
    let children = if at_boundary {
        Vec::new()
    } else {
        node.children
            .iter()
            .map(|child| {
                live_target_node(fixture, *child, request, raw_depth.saturating_add(1), reads)
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let children_count = at_boundary
        .then(|| u32::try_from(node.children.len()).ok())
        .flatten()
        .filter(|count| *count > 0);
    Ok(ObservedSubtree::new(
        node_evidence(node, requirements),
        children,
        true,
        children_count,
    ))
}

fn live_node(
    fixture: &Fixture,
    index: u32,
    requirements: EvidenceRequirements,
) -> Result<ObservedSubtree, AdapterError> {
    let node = fixture
        .nodes
        .get(index as usize)
        .ok_or_else(|| AdapterError::internal("benchmark fixture index is out of bounds"))?;
    let children = node
        .children
        .iter()
        .map(|child| live_node(fixture, *child, requirements))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ObservedSubtree::new(
        node_evidence(node, requirements),
        children,
        true,
        None,
    ))
}

fn node_evidence(node: &FixtureNode, requirements: EvidenceRequirements) -> LocatorEvidence {
    LocatorEvidence {
        role: LocatorField::Known(node.role.clone()),
        name: requested_field(requirements.name, node.name.clone()),
        description: requested_field(requirements.description, None),
        value: requested_field(requirements.value, None),
        identifiers: if requirements.identifiers {
            IdentifierEvidence::typed(
                [
                    node.identifiers.0.clone().map(|value| ElementIdentifier {
                        kind: IdentifierKind::AxIdentifier,
                        value,
                    }),
                    node.identifiers.1.clone().map(|value| ElementIdentifier {
                        kind: IdentifierKind::AxDomIdentifier,
                        value,
                    }),
                ]
                .into_iter()
                .flatten(),
                Some(0),
                true,
            )
        } else {
            IdentifierEvidence::unknown()
        },
        states: if requirements.states {
            LocatorField::Known(Vec::new())
        } else {
            LocatorField::Unknown
        },
        ref_evidence: LocatorRefEvidence {
            window_bounds: LocatorField::Absent,
            bounds: if requirements.ref_evidence.bounds {
                LocatorField::Known(node.bounds)
            } else {
                LocatorField::Unknown
            },
            available_actions: if requirements.ref_evidence.actions {
                LocatorField::Known(actions(node))
            } else {
                LocatorField::Unknown
            },
            descriptors: Default::default(),
        },
    }
}

fn stats_for_indices(
    fixture: &Fixture,
    indices: &[usize],
    requirements: EvidenceRequirements,
) -> LocatorStats {
    let reads = indices
        .iter()
        .map(|index| (*index, requirements))
        .collect::<Vec<_>>();
    stats_for_reads(fixture, &reads)
}

fn stats_for_reads(fixture: &Fixture, reads: &[(usize, EvidenceRequirements)]) -> LocatorStats {
    let count = reads.len() as u64;
    let indices = reads.iter().map(|(index, _)| *index).collect::<Vec<_>>();
    LocatorStats {
        traversal: LocatorTraversalStats {
            nodes_visited: count,
            peak_handles_owned: 0,
            max_raw_depth: 0,
            max_logical_depth: 0,
            web_wrapper_nodes: indices
                .iter()
                .filter_map(|index| fixture.nodes.get(*index))
                .filter(|node| node.role == "group" && node.name.is_none())
                .count() as u64,
            ..LocatorTraversalStats::default()
        },
        reads: LocatorReadStats {
            counts: LocatorReadCounts {
                attribute_batches: count,
                attributes_requested: reads
                    .iter()
                    .map(|(_, requirements)| u64::from(attribute_count(*requirements)))
                    .sum(),
                child_reads: count,
                action_reads: reads
                    .iter()
                    .filter(|(_, requirements)| requirements.ref_evidence.actions)
                    .count() as u64,
                ..LocatorReadCounts::default()
            },
            ..LocatorReadStats::default()
        },
        semantic_reads: LocatorSemanticReadStats {
            settable_reads: reads
                .iter()
                .filter_map(|(index, requirements)| {
                    fixture
                        .nodes
                        .get(*index)
                        .map(|node| modeled_settable_read(node, *requirements))
                })
                .sum(),
            ..LocatorSemanticReadStats::default()
        },
        identifiers: identifier_stats(fixture, &indices),
        ..LocatorStats::default()
    }
}

fn requested_field<T>(requested: bool, value: Option<T>) -> LocatorField<T> {
    if requested {
        value.map_or(LocatorField::Absent, LocatorField::Known)
    } else {
        LocatorField::Unknown
    }
}

fn attribute_count(requirements: EvidenceRequirements) -> u32 {
    let mut mask = 1_u32;
    if requirements.name || requirements.description {
        for index in [1, 2, 3, 15, 16, 17] {
            mask |= 1_u32 << index;
        }
    }
    if requirements.value {
        mask |= 1_u32 << 3;
    }
    if requirements.identifiers {
        mask |= (1_u32 << 13) | (1_u32 << 14);
    }
    if requirements.states {
        for index in 3..=12 {
            mask |= 1_u32 << index;
        }
        mask |= (1_u32 << 18) | (1_u32 << 19);
    }
    if requirements.ref_evidence.bounds {
        for index in 18..=19 {
            mask |= 1_u32 << index;
        }
    }
    if requirements.ref_evidence.actions {
        for index in 20..=21 {
            mask |= 1_u32 << index;
        }
    }
    mask.count_ones()
}

fn modeled_settable_read(node: &FixtureNode, requirements: EvidenceRequirements) -> u64 {
    let state_read = u64::from(requirements.states && node.role == "textfield");
    let action_reads = if requirements.ref_evidence.actions {
        match node.role.as_str() {
            "textfield" => 2,
            "button" => 1,
            _ => 0,
        }
    } else {
        0
    };
    state_read + action_reads
}

fn reachable_indices(fixture: &Fixture, roots: &[u32]) -> Result<Vec<usize>, AdapterError> {
    fn visit(fixture: &Fixture, index: u32, indices: &mut Vec<usize>) -> Result<(), AdapterError> {
        let node = fixture
            .nodes
            .get(index as usize)
            .ok_or_else(|| AdapterError::internal("benchmark fixture index is out of bounds"))?;
        indices.push(index as usize);
        for child in &node.children {
            visit(fixture, *child, indices)?;
        }
        Ok(())
    }

    let mut indices = Vec::new();
    for root in roots {
        visit(fixture, *root, &mut indices)?;
    }
    Ok(indices)
}

fn actions(node: &FixtureNode) -> Vec<String> {
    match node.role.as_str() {
        "button" | "textfield" => vec!["Click".to_string()],
        _ => Vec::new(),
    }
}

fn identifier_stats(fixture: &Fixture, indices: &[usize]) -> LocatorIdentifierStats {
    LocatorIdentifierStats {
        values_observed: indices
            .iter()
            .filter_map(|index| fixture.nodes.get(*index))
            .map(|node| {
                u64::from(node.identifiers.0.is_some()) + u64::from(node.identifiers.1.is_some())
            })
            .sum(),
        nodes_with_identifiers: indices
            .iter()
            .filter_map(|index| fixture.nodes.get(*index))
            .filter(|node| node.identifiers.0.is_some() || node.identifiers.1.is_some())
            .count() as u64,
        nodes_with_multiple_identifiers: indices
            .iter()
            .filter_map(|index| fixture.nodes.get(*index))
            .filter(|node| node.identifiers.0.is_some() && node.identifiers.1.is_some())
            .count() as u64,
        ..LocatorIdentifierStats::default()
    }
}
