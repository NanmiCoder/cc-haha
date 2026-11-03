#[derive(Debug)]
pub(super) struct SessionScope {
    pub(super) id: String,
    pub(super) lease: Option<crate::session::SessionLivenessLease>,
}

impl Clone for SessionScope {
    fn clone(&self) -> Self {
        Self {
            id: self.id.clone(),
            lease: self.lease.clone(),
        }
    }
}

impl SessionScope {
    pub(super) fn ensure_active(&self) -> Result<(), crate::AppError> {
        if crate::session::read_manifest(&self.id)?
            .is_some_and(|manifest| manifest.ended_at.is_some())
        {
            return Err(crate::AdapterError::new(
                crate::ErrorCode::InvalidArgs,
                format!("Session '{}' has ended", self.id),
            )
            .with_suggestion("Unset AGENT_DESKTOP_SESSION and omit --session, then run the command or start a new session")
            .with_details(serde_json::json!({ "kind": "session_ended", "session_id": self.id }))
            .with_disposition(crate::DeliverySemantics::not_delivered())
            .into());
        }
        Ok(())
    }
}

impl super::CommandContext {
    /// Allows repeatable session teardown while ordinary commands remain refused.
    pub fn session_end_scope(&self) -> Result<super::CommandScope<'_>, crate::AppError> {
        self.command_scope_with_disposition(
            "session",
            crate::DeliverySemantics::delivered_unverified(),
            true,
        )
    }
}
