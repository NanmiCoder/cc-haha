mod cardinality;
mod compiled_clause;
mod evaluate;
mod evaluation_buffers;
mod evidence_plan;
mod evidence_requirements;
mod hydrate;
mod identifier_evidence;
mod locator_activation_stats;
mod locator_cardinality;
mod locator_evaluation_stats;
mod locator_evidence;
mod locator_field;
mod locator_identifier_stats;
mod locator_limit_stats;
mod locator_match;
mod locator_match_data;
mod locator_materialization;
mod locator_read_counts;
mod locator_read_health;
mod locator_read_stats;
mod locator_ref_evidence;
mod locator_resolution;
mod locator_resolution_meta;
mod locator_resolve_request;
mod locator_selection;
mod locator_semantic_read_stats;
mod locator_stats;
#[cfg(test)]
mod locator_stats_tests;
mod locator_traversal_stats;
mod match_verdict;
mod materialize;
mod observation_budget;
mod observation_completeness;
mod observation_request;
mod observation_root;
mod observation_source;
mod observed_node;
mod observed_subtree;
mod observed_tree;
mod predicate;
mod ref_evidence_requirements;
mod resolve;
mod select;
mod selection_completeness;
mod validate;

pub use cardinality::{classify_query_result, require_unique};
pub use evaluate::evaluate_locator_tree;
pub use evidence_requirements::EvidenceRequirements;
pub use identifier_evidence::IdentifierEvidence;
pub use locator_activation_stats::LocatorActivationStats;
pub use locator_cardinality::LocatorCardinality;
pub use locator_evaluation_stats::LocatorEvaluationStats;
pub use locator_evidence::LocatorEvidence;
pub use locator_field::LocatorField;
pub use locator_identifier_stats::LocatorIdentifierStats;
pub use locator_limit_stats::LocatorLimitStats;
pub use locator_match::LocatorMatch;
pub use locator_match_data::LocatorMatchData;
pub use locator_materialization::LocatorMaterialization;
pub use locator_read_counts::LocatorReadCounts;
pub use locator_read_health::LocatorReadHealth;
pub use locator_read_stats::LocatorReadStats;
pub use locator_ref_evidence::LocatorRefEvidence;
pub use locator_resolution::LocatorResolution;
pub use locator_resolution_meta::LocatorResolutionMeta;
pub use locator_resolve_request::LocatorResolveRequest;
pub use locator_selection::LocatorSelection;
pub use locator_semantic_read_stats::LocatorSemanticReadStats;
pub use locator_stats::LocatorStats;
pub use locator_traversal_stats::LocatorTraversalStats;
pub use observation_budget::ObservationBudget;
pub(crate) use observation_completeness::ObservationCompleteness;
pub use observation_request::{ObservationMode, ObservationRequest};
pub use observation_root::ObservationRoot;
pub use observation_source::ObservationSource;
pub use observed_node::ObservedNode;
pub use observed_subtree::ObservedSubtree;
pub use observed_tree::ObservedTree;
pub use ref_evidence_requirements::RefEvidenceRequirements;
pub use resolve::resolve_query;
pub use validate::{validate_query, validate_request};

#[cfg(test)]
mod evaluator_identifier_tests;
#[cfg(test)]
mod evaluator_tests;
#[cfg(test)]
mod materialize_tests;
#[cfg(test)]
mod observed_tree_tests;
#[cfg(test)]
mod ownership_tests;
#[cfg(test)]
mod resolve_query_hydration_tests;
#[cfg(test)]
mod resolve_query_tests;
#[cfg(test)]
mod resolve_tests;
#[cfg(test)]
mod retained_identity_tests;
#[cfg(test)]
mod scrollarea_name_tests;
#[cfg(test)]
mod selected_hydration_churn_tests;
#[cfg(test)]
mod selected_hydration_contract_tests;
#[cfg(test)]
mod selected_hydration_subtree_tests;
#[cfg(test)]
mod selected_hydration_tests;
#[cfg(test)]
mod selection_completeness_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod validation_tests;
