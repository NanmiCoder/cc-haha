/// The state letter of `/proc/<pid>/stat`, as a class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcState {
    Running,
    Sleeping,
    Stopped,
    Zombie,
    Dead,
    Other,
}

impl ProcState {
    pub(in crate::system) fn from_letter(letter: &str) -> Self {
        match letter {
            "R" => Self::Running,
            "S" => Self::Sleeping,
            "T" | "t" => Self::Stopped,
            "Z" => Self::Zombie,
            "X" | "x" => Self::Dead,
            _ => Self::Other,
        }
    }
}
