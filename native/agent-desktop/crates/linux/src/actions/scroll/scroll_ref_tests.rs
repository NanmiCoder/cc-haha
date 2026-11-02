use super::*;
use crate::tree::Extents;

#[test]
fn recovery_requires_the_retained_bus_and_object_identity() {
    let path = "/org/gnome/Settings/a11y/58a7ffe5_8929_4d89_a213_005c4ebcc910";
    let mut element = AtspiElement::new(":1.2", path, 40);
    element.set_ancestry(crate::tree::element::ancestry::Ancestry::of(
        Some(AtspiElement::new(
            ":1.2",
            "/org/gnome/Settings/a11y/58a7ffe5_8929_4d89_a213_005c4ebcc911",
            40,
        )),
        Some(AtspiElement::new(
            ":1.2",
            "/org/gnome/Settings/a11y/58a7ffe5_8929_4d89_a213_005c4ebcc912",
            40,
        )),
        false,
    ));
    let toolkit = crate::system::process::toolkit_id::ToolkitId {
        name: Some("GTK".to_owned()),
        version: Some("4.14.5".to_owned()),
    };
    let mut entry = crate::tree::live::test_support::ref_entry("incrementor");
    entry.identity.retained_object = Some(format!(":1.2{path}"));
    assert!(eligible(&entry, &element, &toolkit));
    for other in [path.to_owned(), format!(":1.3{path}")] {
        entry.identity.retained_object = Some(other);
        assert!(!eligible(&entry, &element, &toolkit));
    }
}

fn bounds(y: i32) -> Extents {
    Extents {
        x: 492,
        y,
        width: 379,
        height: 50,
    }
}

fn witness(y: i32, value: f64) -> Witness {
    Witness {
        bar: AtspiElement::new(":1.2", "/bar", 40),
        geometry: Geometry {
            target: Some(bounds(y)),
            container: Some(Extents {
                x: 242,
                y: 46,
                width: 728,
                height: 584,
            }),
            frame: Some(Extents {
                x: 0,
                y: 0,
                width: 980,
                height: 640,
            }),
            neighbour: None,
        },
        range: BarRange {
            min: 0.0,
            max: 1074.0,
            current: value,
        },
        bar_bounds: Extents {
            x: 961,
            y: 46,
            width: 9,
            height: 584,
        },
        orientation: Orientation::Vertical,
    }
}

#[test]
fn viewport_motion_only_translates_the_ref_when_independent_scroll_evidence_agrees() {
    let mut entry = crate::tree::live::test_support::ref_entry("incrementor");
    entry.geometry.bounds = Some(Rect::from(bounds(781)));
    entry.geometry.bounds_space = Some(BoundsSpace::Window);
    let before = witness(781, 0.0);
    let after = witness(46, 735.0);
    let moved = translated(&entry, &before, &after).expect("the content coordinate is unchanged");
    assert_eq!(moved.bounds, Some(Rect::from(bounds(46))));
    assert_eq!(moved.bounds_hash, moved.bounds.unwrap().bounds_hash());
    for mutation in 0..16 {
        let mut before = witness(781, 0.0);
        let mut after = witness(46, 735.0);
        match mutation {
            0 => after.range.current = 734.0,
            1 => after.geometry.target.as_mut().unwrap().x += 1,
            2 => after.geometry.target.as_mut().unwrap().width += 1,
            3 => after.geometry.container.as_mut().unwrap().y += 1,
            4 => after.geometry.frame.as_mut().unwrap().height += 1,
            5 => after.bar = AtspiElement::new(":1.2", "/replacement", 40),
            6 => after.range.max += 1.0,
            7 => after.geometry.target = None,
            8 => after.bar_bounds.y += 1,
            9 => after.orientation = Orientation::Unknown,
            10 => after.orientation = Orientation::Horizontal,
            11 => after.geometry.container.as_mut().unwrap().width = 0,
            12 => after.geometry.frame.as_mut().unwrap().x = i32::MIN,
            13 => after.bar_bounds.height = -1,
            14 => {
                before.range.max = 700.0;
                after.range.max = 700.0;
            }
            _ => {
                before.range.current = -1.0;
                after.range.current = 734.0;
            }
        }
        assert!(
            translated(&entry, &before, &after).is_none(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn only_a_gtk_random_uuid_context_path_can_supply_the_lifecycle_witness() {
    assert!(uuid_context(
        "/org/gnome/Settings/a11y/58a7ffe5_8929_4d89_a213_005c4ebcc910"
    ));
    for path in [
        "/row/1",
        "/org/a11y/atspi/accessible/1",
        "/",
        "/58a7ffe5_8929_1d89_a213_005c4ebcc910",
        "/58a7ffe5_8929_4d89_0213_005c4ebcc910",
    ] {
        assert!(!uuid_context(path), "{path}");
    }
}
