use super::ReadPurpose;

#[test]
fn shape_and_gate_read_the_child_list_and_none_of_the_evidence() {
    for purpose in [ReadPurpose::Shape, ReadPurpose::Gate] {
        assert!(purpose.children());
        assert!(!purpose.identity());
        assert!(!purpose.vocabulary());
        assert!(!purpose.value());
        assert!(!purpose.bounds());
        assert!(!purpose.actions());
    }
}
