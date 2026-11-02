use crate::locator::LocatorQuery;

pub(crate) struct CompiledClause<'a> {
    pub query: &'a LocatorQuery,
    pub has: Option<usize>,
    pub has_not: Option<usize>,
}

pub(crate) fn compile_clauses<'a>(
    query: &'a LocatorQuery,
    clauses: &mut Vec<CompiledClause<'a>>,
) -> usize {
    let has = query
        .containment
        .has
        .as_deref()
        .map(|nested| compile_clauses(nested, clauses));
    let has_not = query
        .containment
        .has_not
        .as_deref()
        .map(|nested| compile_clauses(nested, clauses));
    let index = clauses.len();
    clauses.push(CompiledClause {
        query,
        has,
        has_not,
    });
    index
}
