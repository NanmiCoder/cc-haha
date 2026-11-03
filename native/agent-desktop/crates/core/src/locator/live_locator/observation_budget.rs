use crate::{AdapterError, ErrorCode};

pub const MAX_OBSERVATION_NODES: usize = 50_000;
pub const MAX_OBSERVATION_EDGES: usize = 100_000;
pub const MAX_CHILDREN_PER_NODE: usize = 4_096;
pub const MAX_OBSERVATION_FIELD_BYTES: usize = 64 * 1024;
pub const MAX_OBSERVATION_TEXT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservationBudget {
    pub max_nodes: usize,
    pub max_edges: usize,
    pub max_children_per_node: usize,
    pub max_field_bytes: usize,
    pub max_text_bytes: usize,
}

impl ObservationBudget {
    pub fn validate(self) -> Result<Self, AdapterError> {
        validate_limit("max_nodes", self.max_nodes, MAX_OBSERVATION_NODES)?;
        validate_limit("max_edges", self.max_edges, MAX_OBSERVATION_EDGES)?;
        validate_limit(
            "max_children_per_node",
            self.max_children_per_node,
            MAX_CHILDREN_PER_NODE,
        )?;
        validate_limit(
            "max_field_bytes",
            self.max_field_bytes,
            MAX_OBSERVATION_FIELD_BYTES,
        )?;
        validate_limit(
            "max_text_bytes",
            self.max_text_bytes,
            MAX_OBSERVATION_TEXT_BYTES,
        )?;
        if self.max_field_bytes > self.max_text_bytes {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                "max_field_bytes cannot exceed max_text_bytes",
            ));
        }
        Ok(self)
    }
}

impl Default for ObservationBudget {
    fn default() -> Self {
        Self {
            max_nodes: MAX_OBSERVATION_NODES,
            max_edges: MAX_OBSERVATION_EDGES,
            max_children_per_node: MAX_CHILDREN_PER_NODE,
            max_field_bytes: MAX_OBSERVATION_FIELD_BYTES,
            max_text_bytes: MAX_OBSERVATION_TEXT_BYTES,
        }
    }
}

fn validate_limit(name: &str, value: usize, maximum: usize) -> Result<(), AdapterError> {
    if (1..=maximum).contains(&value) {
        return Ok(());
    }
    Err(AdapterError::new(
        ErrorCode::InvalidArgs,
        format!("{name} must be between 1 and {maximum}, got {value}"),
    ))
}

#[cfg(test)]
#[path = "observation_budget_tests.rs"]
mod tests;
