use super::Rect;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn bounds_hash_differs_when_any_coordinate_differs() {
    let selected = rect(10.0, 20.0, 30.0, 40.0);
    let moved = [
        rect(50.0, 20.0, 30.0, 40.0),
        rect(10.0, 50.0, 30.0, 40.0),
        rect(10.0, 20.0, 50.0, 40.0),
        rect(10.0, 20.0, 30.0, 50.0),
    ];

    for other in moved {
        assert_ne!(selected.bounds_hash(), other.bounds_hash());
    }
}

#[test]
fn bounds_hash_ignores_sub_centi_unit_jitter() {
    let selected = rect(10.0, 20.0, 30.0, 40.0);
    let jittered = rect(10.004, 20.004, 30.004, 40.004);

    assert!(selected.bounds_hash().is_some());
    assert_eq!(selected.bounds_hash(), jittered.bounds_hash());
}
