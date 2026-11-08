use agent_desktop_core::refs::resolve_errors::identity_unknown_error;
use agent_desktop_core::{AdapterError, Deadline, ErrorCode, RefEntry};

use super::landing::Landing;
use super::path_descent::descend;
use super::resolve_errors::no_candidate;
use crate::tree::AtspiElement;
use crate::tree::resolve::{Source, settle_outcome, settle_read_error};
use crate::tree::walk::walker_expand::UNKNOWN_PID;

fn attempt<S: Source>(
    source: &mut S,
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<AtspiElement, AdapterError> {
    if deadline.is_expired() {
        return Err(deadline.timeout_error());
    }
    let frame = source.open_window(entry)?;
    let mut destroyed = None;
    let landing = descend(frame, &entry.scope.path, deadline, |at| {
        let outcome = source.level(at);
        outcome
            .map_err(|error| settle_read_error(source, entry, at, error))
            .inspect_err(|error| {
                if error.code == ErrorCode::ElementNotFound && at.pid() != UNKNOWN_PID {
                    destroyed = Some(error.clone());
                }
            })
    })?;
    if let Some(error) = destroyed {
        return Err(error);
    }
    let Landing { element, unread } = landing;
    let Some(element) = element.filter(|element| element.pid() != UNKNOWN_PID) else {
        return Err(if unread {
            identity_unknown_error(entry)
        } else {
            no_candidate()
        });
    };
    let outcome = source.evidence(&element);
    let evidence = match outcome.map_err(|error| settle_read_error(source, entry, &element, error))
    {
        Ok(evidence) => evidence,
        Err(error)
            if matches!(
                error.code,
                ErrorCode::AppNotFound
                    | ErrorCode::ElementNotFound
                    | ErrorCode::Timeout
                    | ErrorCode::StaleRef
            ) =>
        {
            return Err(error);
        }
        Err(_) => return Err(identity_unknown_error(entry)),
    };
    match evidence.role.known() {
        Some(role) if role == &entry.identity.role => Ok(element),
        Some(_) => Err(no_candidate()),
        None => Err(identity_unknown_error(entry)),
    }
}

/// Lands the element a locator match names, from its stored child-index path
/// alone. Nothing here asks the ref for identity evidence: the entry was
/// built from the element just observed, a zero-area unnamed container is a
/// legitimate match, and the caller's own observation of the landed element
/// checks identity and geometry. The window gate proves the process and window are the stored ones,
/// the path is followed with a full node read per level, and the landing is
/// accepted when its role is the stored one. There is no search: a path that
/// leads nowhere, a different role or a destroyed object is settled at once,
/// so the caller observes afresh instead of waiting. Identity is checked by
/// the caller's own observation of the returned element.
pub(crate) fn resolve_anchor<S: Source>(
    source: &mut S,
    entry: &RefEntry,
    deadline: Deadline,
) -> Result<AtspiElement, AdapterError> {
    let outcome = attempt(source, entry, deadline);
    settle_outcome(source, entry, outcome)
}

#[cfg(test)]
#[path = "resolve_anchor_tests.rs"]
mod tests;
