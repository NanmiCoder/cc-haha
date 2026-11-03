use super::process_facts::ProcessFacts;

/// What a lookup of one process id found. A process that is gone and one
/// that could not be read are different answers: only the first may end a
/// ref's life.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Lookup {
    Found(ProcessFacts),
    Gone,
    Unreadable,
}
