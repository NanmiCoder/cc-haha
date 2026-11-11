use super::LocatorResolveRequest;
use crate::{AdapterError, ErrorCode, locator::LocatorQuery};

const MAX_QUERY_CLAUSES: usize = 64;
const MAX_RAW_DEPTH: u8 = 50;
const MAX_QUERY_FIELD_BYTES: usize = 4_096;
const MAX_QUERY_TOTAL_BYTES: usize = 65_536;

pub fn validate_query(query: &LocatorQuery) -> Result<(), AdapterError> {
    query.validate_states()?;
    let mut clauses = 0;
    let mut total_bytes = 0;
    validate_clause(query, &mut clauses, &mut total_bytes)
}

pub fn validate_request(request: &LocatorResolveRequest) -> Result<(), AdapterError> {
    if (1..=MAX_RAW_DEPTH).contains(&request.max_raw_depth) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::InvalidArgs,
        format!(
            "max_raw_depth must be between 1 and {MAX_RAW_DEPTH}, got {}",
            request.max_raw_depth
        ),
    ))
}

fn validate_clause(
    query: &LocatorQuery,
    clauses: &mut usize,
    total_bytes: &mut usize,
) -> Result<(), AdapterError> {
    *clauses += 1;
    if *clauses > MAX_QUERY_CLAUSES {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("LocatorQuery may contain at most {MAX_QUERY_CLAUSES} recursive clauses"),
        ));
    }
    if let Some(role) = query.identity.role.as_deref()
        && !crate::tree::roles::is_valid_role_query(role)
    {
        return Err(AdapterError::new(
            ErrorCode::InvalidArgs,
            format!("Unknown role query '{role}'"),
        )
        .with_suggestion(
            "Use a role name as a snapshot prints it in a node's 'role' field, not the platform's native role name",
        )
        .unsent());
    }
    for value in [
        query.identity.role.as_deref(),
        query.identity.name.as_deref(),
        query.identity.description.as_deref(),
        query.identity.native_id.as_deref(),
        query.identity.value.as_deref(),
        query.has_text.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value.len() > MAX_QUERY_FIELD_BYTES {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("Locator query field exceeds {MAX_QUERY_FIELD_BYTES} bytes"),
            ));
        }
        *total_bytes = total_bytes.saturating_add(value.len());
        if *total_bytes > MAX_QUERY_TOTAL_BYTES {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("Locator query exceeds {MAX_QUERY_TOTAL_BYTES} aggregate bytes"),
            ));
        }
    }
    if let Some(has) = &query.containment.has {
        validate_clause(has, clauses, total_bytes)?;
    }
    if let Some(has_not) = &query.containment.has_not {
        validate_clause(has_not, clauses, total_bytes)?;
    }
    Ok(())
}
