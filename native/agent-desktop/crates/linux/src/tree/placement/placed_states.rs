/// Fresh state tokens and the placement facts used to derive them.
pub(in crate::tree) struct PlacedStates {
    pub(in crate::tree) states: Vec<String>,
    pub(in crate::tree) hidden: Option<bool>,
    pub(in crate::tree) offscreen: Option<bool>,
}
