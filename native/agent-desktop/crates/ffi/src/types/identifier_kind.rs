#[repr(i32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdIdentifierKind {
    AxIdentifier = 0,
    AxDomIdentifier = 1,
    AutomationId = 2,
    RuntimeId = 3,
    AtspiObjectPath = 4,
}

impl AdIdentifierKind {
    pub(crate) fn from_c(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::AxIdentifier),
            1 => Some(Self::AxDomIdentifier),
            2 => Some(Self::AutomationId),
            3 => Some(Self::RuntimeId),
            4 => Some(Self::AtspiObjectPath),
            _ => None,
        }
    }

    pub(crate) fn to_core(self) -> agent_desktop_core::IdentifierKind {
        match self {
            Self::AxIdentifier => agent_desktop_core::IdentifierKind::AxIdentifier,
            Self::AxDomIdentifier => agent_desktop_core::IdentifierKind::AxDomIdentifier,
            Self::AutomationId => agent_desktop_core::IdentifierKind::AutomationId,
            Self::RuntimeId => agent_desktop_core::IdentifierKind::RuntimeId,
            Self::AtspiObjectPath => agent_desktop_core::IdentifierKind::AtspiObjectPath,
        }
    }
}
