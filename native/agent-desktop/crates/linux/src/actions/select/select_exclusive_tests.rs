use super::*;

#[test]
fn a_selection_with_extra_rows_is_never_verified() {
    assert_eq!(exclusive_verdict(Some(1)), Some(true));
    assert_eq!(exclusive_verdict(Some(2)), None);
    assert_eq!(exclusive_verdict(Some(0)), None);
    assert_eq!(exclusive_verdict(None), None);
}
