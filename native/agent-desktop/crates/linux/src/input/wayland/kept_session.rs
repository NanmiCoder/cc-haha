use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use agent_desktop_core::Deadline;

use super::key_session::KeySession;
use super::remote_desktop::RemoteDesktop;

const IDLE: Duration = Duration::from_secs(5);
const STOP_BUDGET_MS: u64 = 1_000;

/// One kept value and when it was last used.
pub(crate) struct Pool<S> {
    slot: Mutex<Option<(S, Instant)>>,
}

pub(crate) enum Taken<S> {
    Fresh(S),
    Expired(S),
    Empty,
}

impl<S> Pool<S> {
    pub(crate) const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
        }
    }

    pub(crate) fn put(&self, value: S) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = Some((value, Instant::now()));
    }

    pub(crate) fn take(&self, idle: Duration) -> Taken<S> {
        match self
            .slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
        {
            Some((value, since)) if since.elapsed() < idle => Taken::Fresh(value),
            Some((value, _)) => Taken::Expired(value),
            None => Taken::Empty,
        }
    }
}

static KEPT: Pool<RemoteDesktop> = Pool::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
fn stop_quietly(mut session: RemoteDesktop) {
    if let Ok(deadline) = Deadline::detached_after(STOP_BUDGET_MS) {
        let _ = session.stop(deadline);
    }
}

/// The session an earlier delivery of this process left open, when it is
/// recent enough that the compositor still holds its keyboard for it.
pub(crate) fn take() -> Option<RemoteDesktop> {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    match KEPT.take(IDLE) {
        Taken::Fresh(session) => Some(session),
        Taken::Expired(session) => {
            stop_quietly(session);
            None
        }
        Taken::Empty => None,
    }
}

/// Keeps a session open for the next delivery of this process, and stops it
/// once it has been idle for a while, so a long-lived host never holds one.
pub(crate) fn keep(session: RemoteDesktop) {
    KEPT.put(session);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = thread::Builder::new()
        .name("wayland-session-reaper".to_owned())
        .spawn(move || {
            thread::sleep(IDLE + Duration::from_millis(100));
            if GENERATION.load(Ordering::SeqCst) == generation
                && let Taken::Fresh(session) | Taken::Expired(session) = KEPT.take(Duration::ZERO)
            {
                stop_quietly(session);
            }
        });
}

/// Stops the kept session now, for a process that is about to end.
/// Ends the retained keyboard session before CLI exit so delayed compositor
/// teardown cannot take keyboard focus from the next process.
pub fn end() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Taken::Fresh(session) | Taken::Expired(session) = KEPT.take(Duration::ZERO) {
        stop_quietly(session);
    }
}

#[cfg(test)]
#[path = "kept_session_tests.rs"]
mod tests;
