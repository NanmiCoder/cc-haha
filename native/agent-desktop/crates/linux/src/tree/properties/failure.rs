/// What one failed call says on its own. The names of the suspect family are
/// answered both by destroyed objects and by live ones for interfaces they do
/// not implement (L17-2), so on their own they prove nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Failure {
    AppGone,
    Suspect,
    TimedOut,
    Other,
}
