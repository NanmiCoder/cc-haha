use x11rb::protocol::xproto;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MapState {
    Viewable,
    Unviewable,
    Unmapped,
}

impl From<xproto::MapState> for MapState {
    fn from(state: xproto::MapState) -> Self {
        match state {
            xproto::MapState::VIEWABLE => Self::Viewable,
            xproto::MapState::UNVIEWABLE => Self::Unviewable,
            _ => Self::Unmapped,
        }
    }
}
