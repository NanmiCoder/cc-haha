use crate::{AppError, RefEntry};

pub(crate) fn validate_ref_entry(entry: &RefEntry) -> Result<(), AppError> {
    const MAX_FIELD_BYTES: usize = 65_536;
    const MAX_PATH_DEPTH: usize = 256;
    if entry.process.pid.get() == 0
        || entry
            .process
            .process_instance
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Err(AppError::invalid_input(
            "RefEntry requires a positive pid and process instance",
        ));
    }
    if !crate::Role::is_canonical(&entry.identity.role) || entry.identity.role == "unknown" {
        return Err(AppError::invalid_input("RefEntry contains an invalid role"));
    }
    for field in [
        entry.identity.name.as_deref(),
        entry.identity.value.as_deref(),
        entry.identity.description.as_deref(),
        entry.source.source_app.as_deref(),
        entry.source.source_window_id.as_deref(),
        entry.source.source_window_title.as_deref(),
        entry.process.process_instance.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if field.len() > MAX_FIELD_BYTES {
            return Err(AppError::invalid_input(
                "RefEntry string evidence exceeds the field limit",
            ));
        }
    }
    if let Some(identifier) = &entry.identity.native_id
        && (identifier.value.trim().is_empty()
            || identifier.value.len() > MAX_FIELD_BYTES
            || identifier.kind == crate::IdentifierKind::Unknown)
    {
        return Err(AppError::invalid_input(
            "RefEntry contains invalid typed identifier evidence",
        ));
    }
    if entry.scope.path.len() > MAX_PATH_DEPTH {
        return Err(AppError::invalid_input("RefEntry path is too deep"));
    }
    if let Some(bounds) = entry.geometry.bounds {
        bounds.validate()?;
        if entry.geometry.bounds_hash != bounds.bounds_hash() {
            return Err(AppError::invalid_input(
                "RefEntry bounds hash does not match its geometry",
            ));
        }
    }
    if entry.capabilities.states.len() > 256
        || entry.capabilities.available_actions.len() > 256
        || entry
            .capabilities
            .states
            .iter()
            .chain(entry.capabilities.available_actions.iter())
            .any(|value| value.len() > 256)
    {
        return Err(AppError::invalid_input(
            "RefEntry state or action evidence exceeds its limit",
        ));
    }
    Ok(())
}
