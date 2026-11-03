use agent_desktop_core::{AdapterError, DeliverySemantics, ErrorCode};

pub(in crate::actions) fn with_current_row<N: PartialEq, T>(
    observed: Result<N, AdapterError>,
    intended: &N,
    write: impl FnOnce() -> Result<T, AdapterError>,
) -> Result<T, AdapterError> {
    if observed.as_ref().ok() != Some(intended) {
        return Err(AdapterError::new(
            ErrorCode::StaleRef,
            "The selection index no longer identifies the intended row",
        )
        .with_suggestion("Refresh the snapshot before selecting the row again")
        .with_disposition(DeliverySemantics::not_delivered()));
    }
    write()
}

pub(in crate::actions) fn verification<N: PartialEq>(
    combo_value: Option<bool>,
    item_selected: Option<bool>,
    selected_row: Option<&N>,
    intended: &N,
) -> Option<bool> {
    if selected_row.is_some_and(|row| row != intended) {
        return Some(false);
    }
    combo_value.or_else(|| selected_row.map(|row| row == intended).or(item_selected))
}

#[cfg(test)]
#[path = "select_identity_tests.rs"]
mod tests;
