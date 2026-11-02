/// What a probe of one display endpoint found: a server accepting connections,
/// nothing at the address, or an address whose connection was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reach {
    Connected,
    Missing,
    Refused,
}
