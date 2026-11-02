use super::*;

fn frame() -> AtspiElement {
    AtspiElement::new(":1.9", "/frame/1", 7)
}

fn sibling(index: usize, title: Option<&str>, active: Option<bool>) -> Sibling {
    Sibling {
        bus_name: ":1.9".to_owned(),
        path: format!("/frame/{index}"),
        title: title.map(str::to_owned),
        active,
    }
}

#[test]
fn the_frames_that_share_the_title_are_counted_with_their_activity_and_their_own_place() {
    let siblings = [
        sibling(0, Some("Doc"), Some(true)),
        sibling(1, Some("Doc"), Some(false)),
        sibling(2, Some("Other"), Some(true)),
    ];
    let twins = twins_among(&siblings, &frame(), "Doc").expect("every frame answered");
    assert_eq!(twins.active, vec![true, false]);
    assert_eq!(twins.me, 1);
}

#[test]
fn a_frame_that_did_not_answer_leaves_the_count_unproven() {
    let unnamed = [
        sibling(0, None, Some(true)),
        sibling(1, Some("Doc"), Some(false)),
    ];
    assert_eq!(twins_among(&unnamed, &frame(), "Doc"), None);
    let silent = [
        sibling(0, Some("Doc"), None),
        sibling(1, Some("Doc"), Some(false)),
    ];
    assert_eq!(twins_among(&silent, &frame(), "Doc"), None);
}

#[test]
fn a_frame_missing_from_the_application_has_no_twins() {
    let others = [
        sibling(0, Some("Doc"), Some(true)),
        sibling(2, Some("Doc"), Some(false)),
    ];
    assert_eq!(twins_among(&others, &frame(), "Doc"), None);
}

#[test]
fn a_silent_frame_of_another_title_does_not_matter() {
    let siblings = [
        sibling(0, Some("Other"), None),
        sibling(1, Some("Doc"), Some(true)),
    ];
    let twins = twins_among(&siblings, &frame(), "Doc").expect("only the Doc frame counts");
    assert_eq!((twins.active, twins.me), (vec![true], 0));
}
