use super::*;

fn client(id: u32, shadow: (i32, i32, i32, i32), bounds: Option<Extents>) -> X11Client {
    X11Client {
        shadow,
        id,
        hidden: false,
        pid: Some(321),
        title: "Doc".to_owned(),
        extents: None,
        bounds,
    }
}

#[test]
fn the_rectangle_of_a_client_is_its_geometry_less_the_shadow() {
    let geometry = Extents {
        x: 40,
        y: 6,
        width: 863,
        height: 575,
    };
    let clients = [
        client(8, (0, 0, 0, 0), None),
        client(7, (26, 26, 23, 29), Some(geometry)),
    ];
    let drawn = Extents {
        x: 66,
        y: 32,
        width: 814,
        height: 520,
    };
    assert_eq!(rect_of_client(&clients, 7), Some(drawn));
    assert_eq!(rect_of_client(&clients, 8), None);
    assert_eq!(rect_of_client(&clients, 9), None);
}
