use super::*;

fn reg(name: &str, path: &str) -> Registration {
    Registration {
        bus_name: name.into(),
        object_path: path.into(),
    }
}

#[test]
fn name_at_path_splits_on_the_at_sign() {
    assert_eq!(
        parse(":1.55@/org/ayatana/NotificationItem/l21probe"),
        Some(reg(":1.55", "/org/ayatana/NotificationItem/l21probe"))
    );
}

#[test]
fn a_bare_bus_name_takes_the_default_item_path() {
    assert_eq!(
        parse("org.l21.KdeItem"),
        Some(reg("org.l21.KdeItem", "/StatusNotifierItem"))
    );
}

#[test]
fn the_slash_form_keeps_its_bus_name_and_object_path() {
    assert_eq!(
        parse(":1.9/org/kde/Item"),
        Some(reg(":1.9", "/org/kde/Item"))
    );
}

#[test]
fn garbage_is_rejected_without_a_panic() {
    for text in [
        "",
        "   ",
        "@",
        "@/path",
        ":1.5@",
        ":1.5@relative",
        "/only/a/path",
        "nodots",
        "bad name@/p",
        ":1.5@/p//q",
        ":1.5@/p/",
        "\u{0}\u{1}",
        "a@b@c",
    ] {
        assert_eq!(parse(text), None, "{text:?}");
    }
}

#[test]
fn a_repeated_registration_is_listed_once_in_first_seen_order() {
    let listed: Vec<String> = [
        "org.l21.KdeItem",
        ":1.55@/org/ayatana/NotificationItem/l21probe",
        "org.l21.KdeItem",
        "junk",
        ":1.55@/org/ayatana/NotificationItem/l21probe",
    ]
    .map(String::from)
    .to_vec();
    let parsed = parse_all(&listed);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].bus_name, "org.l21.KdeItem");
    assert_eq!(parsed[1].bus_name, ":1.55");
}

#[test]
fn the_same_name_at_two_paths_is_two_items() {
    let listed: Vec<String> = [":1.5@/a", ":1.5@/b"].map(String::from).to_vec();
    assert_eq!(parse_all(&listed).len(), 2);
}
