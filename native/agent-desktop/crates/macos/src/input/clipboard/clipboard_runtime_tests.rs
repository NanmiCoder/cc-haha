use super::*;

#[test]
fn only_always_deny_is_rejected_without_prompting() {
    assert!(!read_access_denied(0));
    assert!(!read_access_denied(1));
    assert!(!read_access_denied(2));
    assert!(read_access_denied(3));
}
