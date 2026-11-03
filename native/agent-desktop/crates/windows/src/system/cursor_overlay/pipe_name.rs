//! The name the overlay's control pipe is reached by.
//!
//! Pure: a deterministic function of the state root, the session id and the
//! protocol generation, so any process that knows those three computes the
//! same name without a lookup file, a registry or a pid.
//!
//! The generation is not decoration. A renderer left running by an earlier
//! build keeps serving a rebuilt binary's controls if the name it answers on
//! does not change when the protocol does — which happens on any rebuild
//! during a live session, every end-to-end run of the overlay included. macOS
//! hashes its protocol version into the socket path for the same reason.

use std::path::Path;

/// Every generation this control protocol has ever had, oldest first, with the
/// one this build speaks last.
///
/// Changing the wire format or the acknowledgement contract means appending
/// here, and an append moves the outgoing generation into the retired set in
/// the same edit. That is the point of the ledger: a maintainer cannot bump
/// the generation without also handing the previous one to the retirement
/// sweep, so a renderer still drawing under it cannot be forgotten.
///
/// With only the live generation in the ledger, the retired set is empty and the sweep is a no-op.
/// That is the correct state for a protocol that has never changed, and it is
/// said out loud rather than left to be discovered: the sweep costs nothing
/// until the first append and does its work from the moment there is one.
pub(crate) const PROTOCOL_GENERATIONS: [&str; 1] = ["w1"];

/// The generation this build speaks. A child whose marker names a different
/// one refuses to serve, and its pipe name differs, so a stale renderer is
/// unreachable rather than subtly wrong.
pub(crate) const PROTOCOL_GENERATION: &str = PROTOCOL_GENERATIONS[PROTOCOL_GENERATIONS.len() - 1];

/// The environment marker that turns an ordinary invocation of this binary
/// into the overlay child. Read before argument parsing, so the child never
/// reaches the CLI at all.
pub(crate) const CHILD_MARKER: &str = "AGENT_DESKTOP_CURSOR_OVERLAY_CHILD";

/// The argv token the child carries beside the marker. The environment block
/// of another process is not readable from outside, so anything that has to
/// recognise this child by inspection — the end-to-end suite's reaper — matches
/// on the command line instead.
///
/// Retiring a stale generation is not such a consumer: it derives that
/// generation's pipe name and speaks to whoever answers it, which needs no
/// command line at all.
pub const CHILD_ARGV_FLAG: &str = "--cursor-overlay-child";

pub(crate) fn pipe_name(root: &Path, session_id: &str, agent_id: Option<&str>) -> String {
    pipe_name_for_generation(root, session_id, agent_id, PROTOCOL_GENERATION)
}

/// The domain the agent segment is hashed under, so an agent id and a session
/// id that happen to be the same string cannot produce the same segment.
const AGENT_HASH_TAG: &str = "agent";

/// The endpoint one renderer answers on.
///
/// A session that names no agent keeps exactly the name it had before agents
/// existed, so an overlay started by such a caller is still reached by the
/// string it always was. An agent adds a second segment rather than being
/// folded into the first, and that is what keeps agent `a` of one session
/// distinct from agent `a` of another: the first segment already carries the
/// state root and the generation, and the second is hashed under its own tag,
/// so no pair of ids can collapse into one value. The reference builds its
/// socket path from the same two segments for the same reasons.
pub(crate) fn pipe_name_for_generation(
    root: &Path,
    session_id: &str,
    agent_id: Option<&str>,
    generation: &str,
) -> String {
    let session = endpoint_hash(root, session_id, generation);
    match agent_id {
        Some(agent_id) => format!(
            r"\\.\pipe\agent-desktop-cursor-{session:016x}-{:016x}",
            endpoint_hash(root, agent_id, AGENT_HASH_TAG)
        ),
        None => format!(r"\\.\pipe\agent-desktop-cursor-{session:016x}"),
    }
}

/// What every one of a session's agent endpoints begins with, without the
/// pipe prefix that enumeration does not report.
///
/// Discovery matches on this rather than on a list of agent ids, because those
/// ids belong to whoever started the renderers and nothing here is told them.
/// A `Disable` names no agent by design, so stopping a session means stopping
/// whatever answers under its prefix.
pub(crate) fn session_prefix(root: &Path, session_id: &str) -> String {
    format!(
        "agent-desktop-cursor-{:016x}-",
        endpoint_hash(root, session_id, PROTOCOL_GENERATION)
    )
}

/// The generations a renderer may still be drawing under that this build can
/// no longer talk to: every entry of the ledger but the last.
///
/// Takes the ledger rather than reading the shipped one, so the promotion rule
/// — appending retires the entry it displaces — is provable against a ledger
/// with more than one generation in it, which the shipped one need not
/// have.
pub(crate) fn retired_generations<'a>(ledger: &'a [&'static str]) -> &'a [&'static str] {
    ledger.split_last().map_or(&[], |(_, earlier)| earlier)
}

/// The argv the child is spawned with: the flag, its session, and its
/// generation. Carried as arguments rather than only in the environment so a
/// process that cannot read the child's environment can still recognise it.
pub(crate) fn child_arguments(session_id: &str, agent_id: Option<&str>) -> Vec<String> {
    let mut arguments = vec![
        CHILD_ARGV_FLAG.to_owned(),
        session_id.to_owned(),
        PROTOCOL_GENERATION.to_owned(),
    ];
    if let Some(agent_id) = agent_id {
        arguments.push(agent_id.to_owned());
    }
    arguments
}

/// The session and generation a command line names, when it is one of ours.
/// The agent token is optional and trails the generation, so a command line
/// written before agents existed still parses as the agent-less child it is.
/// An empty token is read as absent rather than as an agent named nothing,
/// which is the shape a shell that expanded an unset variable produces.
pub(crate) fn parse_child_arguments(
    arguments: &[String],
) -> Option<(String, String, Option<String>)> {
    let flag = arguments
        .iter()
        .position(|value| value == CHILD_ARGV_FLAG)?;
    let session = arguments.get(flag + 1)?;
    let generation = arguments.get(flag + 2)?;
    if session.is_empty() || generation.is_empty() {
        return None;
    }
    let agent = arguments
        .get(flag + 3)
        .filter(|value| !value.is_empty())
        .cloned();
    Some((session.clone(), generation.clone(), agent))
}

fn endpoint_hash(root: &Path, session_id: &str, generation: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    let root = root.to_string_lossy();
    for byte in root
        .as_bytes()
        .iter()
        .chain(session_id.as_bytes())
        .chain(generation.as_bytes())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(test)]
#[path = "pipe_name_tests.rs"]
mod tests;
