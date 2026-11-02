use super::leaves;
use agent_desktop_core::Point;

#[test]
fn a_move_somewhere_else_leaves_and_one_that_stays_put_does_not() {
    let at = Point { x: 100.0, y: 50.0 };

    assert!(leaves(&at, &Point { x: 140.0, y: 50.0 }));
    assert!(!leaves(&at, &Point { x: 101.0, y: 50.5 }));
}
