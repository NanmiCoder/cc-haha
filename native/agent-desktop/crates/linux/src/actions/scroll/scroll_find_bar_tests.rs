use super::*;

fn node(parent: Option<usize>) -> Site {
    Site { parent, bar: None }
}

fn bar(parent: usize, way: Orientation) -> Site {
    Site {
        parent: Some(parent),
        bar: Some(way),
    }
}

#[test]
fn the_bar_beside_the_nearest_ancestor_of_the_target_wins() {
    let sites = [
        node(None),
        node(Some(0)),
        node(Some(1)),
        node(Some(2)),
        bar(0, Orientation::Vertical),
        bar(2, Orientation::Vertical),
    ];
    assert_eq!(
        choose_bar(&sites, Some(3), Axis::Vertical).unwrap(),
        Some(5)
    );
}

#[test]
fn a_bar_beside_something_the_target_is_not_under_is_not_chosen() {
    let sites = [
        node(None),
        node(Some(0)),
        node(Some(0)),
        node(Some(1)),
        bar(2, Orientation::Vertical),
        bar(2, Orientation::Vertical),
    ];
    assert_eq!(choose_bar(&sites, Some(3), Axis::Vertical).unwrap(), None);
}

#[test]
fn the_axis_picks_between_two_bars_of_one_pane() {
    let sites = [
        node(None),
        node(Some(0)),
        bar(0, Orientation::Horizontal),
        bar(0, Orientation::Vertical),
    ];
    assert_eq!(
        choose_bar(&sites, Some(1), Axis::Vertical).unwrap(),
        Some(3)
    );
    assert_eq!(
        choose_bar(&sites, Some(1), Axis::Horizontal).unwrap(),
        Some(2)
    );
}

#[test]
fn a_scroll_bar_cannot_reveal_itself_or_a_sibling_bar() {
    let sites = [
        node(None),
        bar(0, Orientation::Horizontal),
        bar(0, Orientation::Vertical),
    ];
    for target in [1, 2] {
        for axis in [Axis::Vertical, Axis::Horizontal] {
            assert_eq!(choose_bar(&sites, Some(target), axis).unwrap(), None);
        }
    }
}

#[test]
fn an_outer_scroll_bar_can_reveal_a_nested_scroll_bar() {
    let sites = [
        node(None),
        node(Some(0)),
        bar(1, Orientation::Horizontal),
        bar(1, Orientation::Vertical),
        bar(0, Orientation::Vertical),
    ];
    assert_eq!(
        choose_bar(&sites, Some(2), Axis::Vertical).unwrap(),
        Some(4)
    );
}

#[test]
fn a_target_the_crawl_never_met_uses_the_only_bar_that_runs_the_right_way() {
    let one = [node(None), bar(0, Orientation::Vertical)];
    assert_eq!(choose_bar(&one, None, Axis::Vertical).unwrap(), Some(1));
    let two = [
        node(None),
        bar(0, Orientation::Vertical),
        bar(0, Orientation::Unknown),
    ];
    assert_eq!(
        choose_bar(&two, None, Axis::Vertical).unwrap_err().code,
        ErrorCode::AmbiguousTarget
    );
    assert_eq!(choose_bar(&one, None, Axis::Horizontal).unwrap(), None);
}

#[test]
fn a_bar_that_names_its_direction_beats_one_that_does_not_beside_the_same_pane() {
    let sites = [
        node(None),
        node(Some(0)),
        bar(0, Orientation::Unknown),
        bar(0, Orientation::Vertical),
    ];
    assert_eq!(
        choose_bar(&sites, Some(1), Axis::Vertical).unwrap(),
        Some(3)
    );
}

#[test]
fn a_located_target_with_no_bar_above_it_does_not_borrow_the_bar_of_another_pane() {
    let sites = [
        node(None),
        node(Some(0)),
        node(Some(0)),
        node(Some(1)),
        bar(2, Orientation::Vertical),
    ];
    assert_eq!(choose_bar(&sites, Some(3), Axis::Vertical).unwrap(), None);
}

#[test]
fn equally_ranked_bars_are_ambiguous_instead_of_chosen_by_crawl_order() {
    let sites = [
        node(None),
        node(Some(0)),
        bar(0, Orientation::Vertical),
        bar(0, Orientation::Vertical),
    ];
    assert_eq!(
        choose_bar(&sites, Some(1), Axis::Vertical)
            .unwrap_err()
            .code,
        ErrorCode::AmbiguousTarget
    );
}
