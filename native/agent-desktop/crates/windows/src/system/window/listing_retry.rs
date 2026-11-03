use agent_desktop_core::{AdapterError, Deadline, ErrorCode};

/// How many times a walk over the live window set is re-attempted after it
/// catches its own transient identity race, before that race is accepted as
/// a genuine refusal.
///
/// Shared by every caller on this path - the signal inventory's single-pass
/// walk, the launch command's window observation, and `list_windows` itself -
/// so the budget cannot silently drift between them and leave one caller
/// retrying less than the others.
pub(crate) const LISTING_RACE_ATTEMPTS: u32 = 5;

/// Retries `attempt` up to `LISTING_RACE_ATTEMPTS` times under `deadline`,
/// continuing only while `is_race` classifies the returned error as the
/// transient mid-walk identity race this helper exists to absorb.
///
/// Any other error returns immediately, and so does the last race error once
/// every attempt is spent: what a caller does with an exhausted race - a
/// synthesized error, `Ok(None)`, the raw refusal unchanged - is its own
/// decision, not this helper's. Each attempt opens with the same
/// `ensure_remaining` preamble every native call on this path uses, so a
/// deadline that expires mid-retry surfaces as `TIMEOUT` rather than as one
/// more race attempt.
pub(crate) fn retry_transient_window_race<T>(
    deadline: Deadline,
    is_race: impl Fn(&AdapterError) -> bool,
    mut attempt: impl FnMut() -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    let mut last_race_error: Option<AdapterError> = None;
    for _ in 0..LISTING_RACE_ATTEMPTS {
        deadline.ensure_remaining()?;
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) if is_race(&error) => last_race_error = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last_race_error.unwrap_or_else(|| deadline.timeout_error()))
}

/// Narrows any failure raised on this feature set's read paths onto the
/// closed set core's poll loop retries: `TIMEOUT` passes through unchanged,
/// everything else becomes `APP_UNRESPONSIVE`, the one "could not read the
/// desktop right now" code every caller on this path accepts.
pub(crate) fn narrow_to_permitted_codes(mut error: AdapterError) -> AdapterError {
    if error.code != ErrorCode::Timeout {
        error.code = ErrorCode::AppUnresponsive;
    }
    error
}

#[cfg(test)]
#[path = "listing_retry_tests.rs"]
mod tests;
