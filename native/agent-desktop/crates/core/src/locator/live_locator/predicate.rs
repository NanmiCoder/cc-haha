use super::match_verdict::MatchVerdict;
use super::{LocatorEvidence, LocatorField, LocatorIdentifierStats};
use crate::{
    locator::{ContainmentPredicate, IdentityPredicate, LocatorQuery},
    tree::roles,
    tree::search_text,
    tree::state,
};

pub(crate) fn normalize_query(query: &LocatorQuery) -> LocatorQuery {
    LocatorQuery {
        identity: IdentityPredicate {
            role: query
                .identity
                .role
                .as_deref()
                .map(roles::normalize_role_query),
            name: query.identity.name.as_deref().map(search_text::normalize),
            description: query
                .identity
                .description
                .as_deref()
                .map(search_text::normalize),
            native_id: query.identity.native_id.clone(),
            value: query.identity.value.as_deref().map(search_text::normalize),
        },
        has_text: query.has_text.as_deref().map(search_text::normalize),
        exact: query.exact,
        states: query.states.clone(),
        containment: ContainmentPredicate {
            has: query
                .containment
                .has
                .as_deref()
                .map(normalize_query)
                .map(Box::new),
            has_not: query
                .containment
                .has_not
                .as_deref()
                .map(normalize_query)
                .map(Box::new),
        },
    }
}

pub(crate) fn self_verdict(
    query: &LocatorQuery,
    evidence: &LocatorEvidence,
    identifier_stats: &mut LocatorIdentifierStats,
) -> MatchVerdict {
    let (identifier, identifier_match) =
        identifier_verdict(query.identity.native_id.as_deref(), evidence);
    let verdict = role_verdict(query.identity.role.as_deref(), &evidence.role)
        .and(identifier)
        .and(states_verdict(query, evidence));
    if verdict == MatchVerdict::NoMatch {
        return verdict;
    }
    let verdict = verdict
        .and(text_verdict(
            query.identity.name.as_deref(),
            &evidence.name,
            query.exact,
        ))
        .and(text_verdict(
            query.identity.description.as_deref(),
            &evidence.description,
            query.exact,
        ))
        .and(text_verdict(
            query.identity.value.as_deref(),
            &evidence.value,
            query.exact,
        ));
    if verdict == MatchVerdict::Match {
        match identifier_match {
            Some(IdentifierMatch::Preferred) => identifier_stats.preferred_matches += 1,
            Some(IdentifierMatch::Fallback) => identifier_stats.fallback_matches += 1,
            None => {}
        }
    }
    verdict
}

pub(crate) fn self_text_verdict(
    expected: Option<&str>,
    evidence: &LocatorEvidence,
    exact: bool,
) -> MatchVerdict {
    let Some(expected) = expected else {
        return MatchVerdict::Match;
    };
    let mut verdict = MatchVerdict::NoMatch;
    for field in [&evidence.name, &evidence.description, &evidence.value] {
        verdict = verdict.or(text_verdict(Some(expected), field, exact));
        if verdict == MatchVerdict::Match {
            return verdict;
        }
    }
    verdict
}

fn role_verdict(expected: Option<&str>, actual: &LocatorField<String>) -> MatchVerdict {
    let Some(expected) = expected else {
        return MatchVerdict::Match;
    };
    match actual {
        LocatorField::Known(actual) => bool_verdict(actual == expected),
        LocatorField::Absent => MatchVerdict::NoMatch,
        LocatorField::Unknown => MatchVerdict::Unknown,
    }
}

fn text_verdict(
    expected: Option<&str>,
    actual: &LocatorField<String>,
    exact: bool,
) -> MatchVerdict {
    let Some(expected) = expected else {
        return MatchVerdict::Match;
    };
    match actual {
        LocatorField::Known(actual) => {
            let matched = if exact {
                search_text::normalize(actual) == expected
            } else {
                search_text::contains(actual, expected)
            };
            bool_verdict(matched)
        }
        LocatorField::Absent => MatchVerdict::NoMatch,
        LocatorField::Unknown => MatchVerdict::Unknown,
    }
}

fn identifier_verdict(
    expected: Option<&str>,
    evidence: &LocatorEvidence,
) -> (MatchVerdict, Option<IdentifierMatch>) {
    let Some(expected) = expected else {
        return (MatchVerdict::Match, None);
    };
    if evidence.identifiers.preferred_value() == Some(expected) {
        return (MatchVerdict::Match, Some(IdentifierMatch::Preferred));
    }
    if evidence
        .identifiers
        .identifiers()
        .iter()
        .any(|actual| actual.value == expected)
    {
        return (MatchVerdict::Match, Some(IdentifierMatch::Fallback));
    }
    let verdict = if !evidence.identifiers.is_complete() {
        MatchVerdict::Unknown
    } else {
        MatchVerdict::NoMatch
    };
    (verdict, None)
}

#[derive(Clone, Copy)]
enum IdentifierMatch {
    Preferred,
    Fallback,
}

fn states_verdict(query: &LocatorQuery, evidence: &LocatorEvidence) -> MatchVerdict {
    if query.states.is_empty() {
        return MatchVerdict::Match;
    }
    match &evidence.states {
        LocatorField::Known(states) => bool_verdict(query.states.iter().all(|predicate| {
            state::has_state(states, &predicate.token) == predicate.expected.unwrap_or(true)
        })),
        LocatorField::Absent => bool_verdict(
            query
                .states
                .iter()
                .all(|predicate| predicate.expected == Some(false)),
        ),
        LocatorField::Unknown => MatchVerdict::Unknown,
    }
}

fn bool_verdict(matched: bool) -> MatchVerdict {
    if matched {
        MatchVerdict::Match
    } else {
        MatchVerdict::NoMatch
    }
}
