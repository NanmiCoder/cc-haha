use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepMechanism {
    SemanticApi,
    PhysicalSynthetic,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn semantic_api_serializes_to_snake_case() {
        assert_eq!(
            serde_json::to_value(StepMechanism::SemanticApi).unwrap(),
            json!("semantic_api")
        );
    }

    #[test]
    fn physical_synthetic_serializes_to_snake_case() {
        assert_eq!(
            serde_json::to_value(StepMechanism::PhysicalSynthetic).unwrap(),
            json!("physical_synthetic")
        );
    }

    #[test]
    fn semantic_api_round_trips_from_value() {
        let value: StepMechanism = serde_json::from_value(json!("semantic_api")).unwrap();
        assert_eq!(value, StepMechanism::SemanticApi);
    }

    #[test]
    fn physical_synthetic_round_trips_from_value() {
        let value: StepMechanism = serde_json::from_value(json!("physical_synthetic")).unwrap();
        assert_eq!(value, StepMechanism::PhysicalSynthetic);
    }
}
