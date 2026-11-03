/// The outcome of reading one piece of a node: the value, a confirmed
/// absence, or a failed read. A failure is never turned into a default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Field<T> {
    Present(T),
    Absent,
    Failed(String),
}

impl<T> Field<T> {
    pub(crate) fn is_failed(&self) -> bool {
        matches!(self, Self::Failed(_))
    }

    pub(crate) fn map<U>(self, convert: impl FnOnce(T) -> U) -> Field<U> {
        match self {
            Self::Present(value) => Field::Present(convert(value)),
            Self::Absent => Field::Absent,
            Self::Failed(detail) => Field::Failed(detail),
        }
    }

    pub(crate) fn present(&self) -> Option<&T> {
        match self {
            Self::Present(value) => Some(value),
            Self::Absent | Self::Failed(_) => None,
        }
    }
}

impl Field<String> {
    /// Whether the text is empty or absent; a failed read is not blank.
    pub(crate) fn is_blank(&self) -> bool {
        match self {
            Self::Present(text) => text.trim().is_empty(),
            Self::Absent => true,
            Self::Failed(_) => false,
        }
    }

    /// The text when the read succeeded and it is not blank.
    pub(crate) fn non_blank(&self) -> Option<&String> {
        self.present().filter(|text| !text.trim().is_empty())
    }
}
