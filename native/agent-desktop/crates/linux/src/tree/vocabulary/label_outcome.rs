/// What reading a node's `LabelledBy` relation produced.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) enum LabelOutcome {
    /// The node has no label relation, or its target has no text.
    Unlabelled,
    /// The label resolved and its text is readable.
    Text(String),
    /// The relation or the target's name could not be read.
    Failed,
}
