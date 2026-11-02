#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdStepMechanism {
    SemanticApi = 1,
    PhysicalSynthetic = 2,
}

#[cfg(test)]
mod tests {
    use super::AdStepMechanism;

    #[test]
    fn discriminants_are_abi_stable() {
        assert_eq!(AdStepMechanism::SemanticApi as i32, 1);
        assert_eq!(AdStepMechanism::PhysicalSynthetic as i32, 2);
    }
}
