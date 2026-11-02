use super::super::expiry_detail;

#[test]
fn open_direction_with_no_read_names_the_direction_and_the_missing_poll() {
    assert_eq!(
        expiry_detail(true, true),
        "No menu opened before the deadline; no poll read the menu state before the deadline"
    );
}

#[test]
fn open_direction_with_a_read_names_only_the_direction() {
    assert_eq!(
        expiry_detail(true, false),
        "No menu opened before the deadline"
    );
}

#[test]
fn close_direction_with_no_read_names_the_direction_and_the_missing_poll() {
    assert_eq!(
        expiry_detail(false, true),
        "Menu did not close before the deadline; no poll read the menu state before the deadline"
    );
}

#[test]
fn close_direction_with_a_read_names_only_the_direction() {
    assert_eq!(
        expiry_detail(false, false),
        "Menu did not close before the deadline"
    );
}
