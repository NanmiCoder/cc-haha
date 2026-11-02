use crate::Rect;

#[derive(Debug, Clone)]
pub struct PointerObservation {
    pub bounds: Option<Rect>,
    pub states: Vec<String>,
}
