/// Associates adapter-native connection state with a caller-managed session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionAffinity {
    pub session_id: Option<String>,
}
