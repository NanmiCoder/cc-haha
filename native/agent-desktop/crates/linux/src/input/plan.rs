use super::step::Step;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Plan {
    pub(crate) steps: Vec<Step>,
    pub(crate) release_origin: Option<(i32, i32)>,
}
