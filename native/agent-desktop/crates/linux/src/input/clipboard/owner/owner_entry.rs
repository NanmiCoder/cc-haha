use super::owner_files;
use super::owner_payload::read_payload;
use super::owner_record::{self, OwnerRecord};
use super::owner_serve::serve;
use super::owner_wire::claim;
use crate::input::clipboard::payload::GENERATION;

pub(crate) const MARKER_ENV: &str = "AGENT_DESKTOP_SELECTION_OWNER";
pub(crate) const BUILD_IDENTITY_ENV: &str = "AGENT_DESKTOP_SELECTION_BUILD";
pub(crate) const PAYLOAD_FD_ENV: &str = "AGENT_DESKTOP_SELECTION_PAYLOAD_FD";
pub(crate) const DISPLAY_ENV: &str = "AGENT_DESKTOP_SELECTION_DISPLAY";
pub(crate) const NONCE_ENV: &str = "AGENT_DESKTOP_SELECTION_NONCE";

const EXIT_OK: i32 = 0;
const EXIT_FAILED: i32 = 1;
const EXIT_USAGE: i32 = 2;

/// The identity a helper shares with the library that spawns it. A helper
/// left beside a newer library carries another one and refuses to run.
pub(crate) fn build_identity() -> String {
    format!("{}:{}", env!("CARGO_PKG_VERSION"), GENERATION)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct OwnerEnv {
    pub(crate) marker: Option<String>,
    pub(crate) build: Option<String>,
    pub(crate) payload_fd: Option<String>,
    pub(crate) display: Option<String>,
    pub(crate) nonce: Option<String>,
}

impl OwnerEnv {
    fn from_process() -> Self {
        let read = |name: &str| std::env::var(name).ok();
        Self {
            marker: read(MARKER_ENV),
            build: read(BUILD_IDENTITY_ENV),
            payload_fd: read(PAYLOAD_FD_ENV),
            display: read(DISPLAY_ENV),
            nonce: read(NONCE_ENV),
        }
    }

    fn is_for_this_build(&self) -> bool {
        self.marker.as_deref() == Some(GENERATION.to_string().as_str())
            && self.build.as_deref() == Some(build_identity().as_str())
    }
}

/// What the helper's `main` calls. An absent or foreign marker, or another
/// build identity, is a usage error that never reaches the X server.
pub(crate) fn run_checked(env: OwnerEnv, owner: impl FnOnce(OwnerEnv) -> i32) -> i32 {
    if env.is_for_this_build() {
        owner(env)
    } else {
        EXIT_USAGE
    }
}

pub fn run_from_env() -> i32 {
    run_checked(OwnerEnv::from_process(), run_owner)
}

fn start_session() -> Result<(), String> {
    rustix::process::setsid()
        .map(|_| ())
        .map_err(|error| format!("the owner could not start its own session: {error}"))
}

fn fail(env: &OwnerEnv, message: &str) -> i32 {
    if let (Some(dir), Some(display), Some(nonce)) = (
        owner_record::record_dir(),
        env.display.as_deref(),
        env.nonce.as_deref(),
    ) {
        let _ = owner_record::publish_failure(&dir, display, nonce, message);
    }
    EXIT_FAILED
}

fn run_owner(env: OwnerEnv) -> i32 {
    let (Some(display), Some(nonce)) = (env.display.clone(), env.nonce.clone()) else {
        return EXIT_USAGE;
    };
    let Some(dir) = owner_record::record_dir() else {
        return EXIT_FAILED;
    };
    if !owner_record::valid_nonce(&nonce) {
        return EXIT_USAGE;
    }
    if let Err(message) = start_session() {
        return fail(&env, &message);
    }
    if let Err(error) = owner_files::ensure_private_dir(&dir) {
        return fail(
            &env,
            &format!("the owner record storage is not usable: {error}"),
        );
    }
    let payload = match read_payload(env.payload_fd.as_deref()) {
        Ok(payload) => payload,
        Err(message) => return fail(&env, &message),
    };
    let mut claimed = match claim(&display, &payload) {
        Ok(claimed) => claimed,
        Err(message) => return fail(&env, &message),
    };
    let pid = std::process::id();
    let Some(start_ticks) = owner_record::start_ticks_of(pid) else {
        return fail(&env, "the owner could not read its own start time");
    };
    let record = OwnerRecord {
        pid,
        start_ticks,
        display: owner_record::normalise_display(&display),
        window: claimed.window,
        nonce,
    };
    if let Err(error) = owner_record::publish(&dir, &record) {
        return fail(
            &env,
            &format!("the owner record could not be written: {error}"),
        );
    }
    serve(&mut claimed.wire, &claimed.answerer, claimed.chunk_bytes);
    owner_record::remove_own(&dir, &record);
    EXIT_OK
}

#[cfg(test)]
#[path = "owner_entry_tests.rs"]
mod tests;
