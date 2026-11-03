use super::retained_store::RetainedStore;
use crate::tree::AXElement;
use agent_desktop_core::{
    AdapterError, DeliverySemantics, ErrorCode, IdentifierEvidence, IdentityMatch, RefEntry,
};
use std::cell::RefCell;
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static STORE: RefCell<Option<RetainedStore>> = const { RefCell::new(None) };
}

/// Owns retained AX identity on the calling thread until dropped.
pub struct RetainedRefSession {
    _owner_thread: PhantomData<Rc<()>>,
}

impl RetainedRefSession {
    pub fn capture_count(&self) -> usize {
        STORE.with(|slot| {
            slot.borrow()
                .as_ref()
                .map_or(0, RetainedStore::capture_count)
        })
    }

    pub fn retain(&self, live: &std::collections::HashSet<String>) {
        STORE.with(|slot| {
            if let Some(store) = slot.borrow_mut().as_mut() {
                store.retain(live);
            }
        });
    }

    pub fn start() -> Result<Self, AdapterError> {
        let pid = i32::try_from(std::process::id())
            .map_err(|_| AdapterError::internal("Host PID exceeds pid_t"))?;
        let process = crate::system::process::process_identity::token_for_pid(pid)?
            .ok_or_else(|| AdapterError::internal("Host process identity is unavailable"))?;
        let generation = NEXT_GENERATION
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next| {
                next.checked_add(1)
            })
            .map_err(|_| AdapterError::internal("Retained identity generation exhausted"))?;
        STORE.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_some() {
                return Err(AdapterError::internal(
                    "This thread already owns retained refs",
                ));
            }
            *slot = Some(RetainedStore::new(format!("{pid}:{process}:{generation}")));
            Ok(Self {
                _owner_thread: PhantomData,
            })
        })
    }
}

impl Drop for RetainedRefSession {
    fn drop(&mut self) {
        STORE.with(|slot| {
            slot.borrow_mut().take();
        });
    }
}

#[cfg(target_os = "macos")]
pub(in crate::tree) fn element_hash(element: &AXElement) -> u64 {
    if element.0.is_null() {
        return 0;
    }
    unsafe { core_foundation::base::CFHash(element.0.cast()) as u64 }
}

#[cfg(not(target_os = "macos"))]
pub(in crate::tree) fn element_hash(_element: &AXElement) -> u64 {
    0
}

pub(crate) fn capture(element: &AXElement) -> Result<Option<String>, AdapterError> {
    STORE.with(|slot| {
        slot.borrow_mut()
            .as_mut()
            .map(|store| store.capture(element))
            .transpose()
    })
}

pub(crate) fn evidence(element: &AXElement, identifiers: IdentifierEvidence) -> IdentifierEvidence {
    STORE.with(|slot| {
        match slot
            .borrow()
            .as_ref()
            .and_then(|store| store.lookup(element))
        {
            Some(token) => identifiers.with_retained_object(token.to_owned()),
            None => identifiers,
        }
    })
}

pub(crate) fn validate(token: Option<&str>) -> Result<(), AdapterError> {
    let Some(token) = token else {
        return Ok(());
    };
    let found = STORE.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|store| store.contains_token(token))
    });
    if found {
        Ok(())
    } else {
        Err(AdapterError::new(
            ErrorCode::StaleRef,
            "The native object owner is no longer available",
        )
        .with_suggestion("Take a fresh snapshot in the active session")
        .with_disposition(DeliverySemantics::not_delivered()))
    }
}

pub(crate) fn matches(token: &str, element: &AXElement) -> Result<bool, AdapterError> {
    validate(Some(token))?;
    Ok(STORE.with(|slot| {
        slot.borrow()
            .as_ref()
            .and_then(|store| store.lookup(element))
            .is_some_and(|actual| actual == token)
    }))
}

#[cfg(target_os = "macos")]
pub(crate) fn candidate_match(
    element: &AXElement,
    entry: &RefEntry,
    evidence: &agent_desktop_core::LocatorEvidence,
) -> Result<IdentityMatch, AdapterError> {
    if let Some(token) = entry.identity.retained_object.as_deref() {
        return Ok(if matches(token, element)? {
            IdentityMatch::Match
        } else {
            IdentityMatch::NoMatch
        });
    }
    Ok(super::resolve_search::match_native_or_text_identity(
        entry, evidence,
    ))
}

#[cfg(all(test, target_os = "macos"))]
#[path = "retained_tests.rs"]
mod tests;
