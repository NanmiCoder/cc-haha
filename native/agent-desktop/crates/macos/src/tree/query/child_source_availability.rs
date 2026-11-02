#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChildSourceAvailability {
    Available,
    Unavailable,
    Unknown,
}
