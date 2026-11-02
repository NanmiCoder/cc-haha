use super::*;

#[test]
fn malformed_state_properties_are_unknown() {
    let wanted = [10, 20, 30];
    assert_eq!(decode_state(8, &[0; 4], 0, wanted), None);
    assert_eq!(decode_state(32, &[0; 7], 0, wanted), None);
    assert_eq!(decode_state(32, &[0; 4], 4, wanted), None);
}
