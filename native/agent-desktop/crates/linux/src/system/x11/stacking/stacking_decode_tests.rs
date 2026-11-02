use super::*;

fn bytes_of(values: &[u32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}

const STATES: StateAtoms = StateAtoms {
    hidden: 301,
    above: 302,
};

#[test]
fn the_first_listed_window_type_names_the_kind() {
    let types = TypeAtoms {
        normal: 401,
        dialog: 402,
        utility: 403,
        menu: [404, 405, 406],
        dock: 407,
        desktop: 408,
    };
    let kind = |atoms: &[u32]| decode_kind(32, &bytes_of(atoms), types);
    assert_eq!(kind(&[types.dialog, types.normal]), WindowKind::Dialog);
    assert_eq!(kind(&[types.menu[2]]), WindowKind::Menu);
    assert_eq!(kind(&[types.dock]), WindowKind::Dock);
    assert_eq!(kind(&[types.desktop]), WindowKind::Desktop);
    assert_eq!(kind(&[types.utility]), WindowKind::Utility);
    assert_eq!(kind(&[999]), WindowKind::Other);
    assert_eq!(kind(&[]), WindowKind::Normal);
}

#[test]
fn a_state_property_that_cannot_be_decoded_carries_no_flag() {
    assert_eq!(decode_state(8, &[1, 2, 3, 4], STATES), (false, false));
}

#[test]
fn a_malformed_desktop_property_is_unknown() {
    assert_eq!(decode_desktop(32, &[]), DesktopPlacement::Unknown);
    assert_eq!(decode_desktop(8, &[1]), DesktopPlacement::Unknown);
}

#[test]
fn the_current_desktop_is_the_single_cardinal() {
    assert_eq!(decode_current_desktop(32, &bytes_of(&[1])), Some(1));
    assert_eq!(decode_current_desktop(32, &bytes_of(&[1, 2])), None);
}

#[test]
fn a_property_cut_short_by_the_length_asked_for_is_not_a_value() {
    assert_eq!(
        complete_value(32, vec![1, 2, 3, 4], 0),
        Some((32, vec![1, 2, 3, 4]))
    );
    assert_eq!(complete_value(32, vec![1, 2, 3, 4], 8), None);
    assert_eq!(complete_value(0, Vec::new(), 0), Some((0, Vec::new())));
}

#[test]
fn more_windows_than_a_read_probes_exceed_the_cap() {
    assert!(!exceeds_cap(MAX_ENTRIES));
    assert!(exceeds_cap(MAX_ENTRIES + 1));
}
