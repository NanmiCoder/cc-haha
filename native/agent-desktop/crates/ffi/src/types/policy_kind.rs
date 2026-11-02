#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdPolicyKind {
    Headless = 0,
    FocusFallback = 1,
    Headed = 2,
}

impl AdPolicyKind {
    pub(crate) fn to_interaction_policy(
        self,
    ) -> agent_desktop_core::actions::interaction_policy::InteractionPolicy {
        match self {
            Self::Headless => {
                agent_desktop_core::actions::interaction_policy::InteractionPolicy::headless()
            }
            Self::FocusFallback => {
                agent_desktop_core::actions::interaction_policy::InteractionPolicy::focus_fallback()
            }
            Self::Headed => {
                agent_desktop_core::actions::interaction_policy::InteractionPolicy::headed()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::actions::interaction_policy::InteractionPolicy;

    #[test]
    fn discriminants_are_abi_stable() {
        assert_eq!(AdPolicyKind::Headless as i32, 0);
        assert_eq!(AdPolicyKind::FocusFallback as i32, 1);
        assert_eq!(AdPolicyKind::Headed as i32, 2);
    }

    #[test]
    fn policy_kind_headless_maps_to_headless() {
        assert_eq!(
            AdPolicyKind::Headless.to_interaction_policy(),
            InteractionPolicy::headless()
        );
    }

    #[test]
    fn policy_kind_focus_fallback_maps_to_focus_fallback() {
        assert_eq!(
            AdPolicyKind::FocusFallback.to_interaction_policy(),
            InteractionPolicy::focus_fallback()
        );
    }

    #[test]
    fn policy_kind_headed_maps_to_headed() {
        assert_eq!(
            AdPolicyKind::Headed.to_interaction_policy(),
            InteractionPolicy::headed()
        );
    }
}
