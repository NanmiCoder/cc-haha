#[test]
fn objective_c_screen_boundary_contains_exceptions_and_temporary_objects() {
    let source = include_str!("screen_bridge.m");

    assert!(source.contains("@try"));
    assert!(source.contains("@autoreleasepool"));
    assert!(source.contains("@catch (NSException *exception)"));
}
