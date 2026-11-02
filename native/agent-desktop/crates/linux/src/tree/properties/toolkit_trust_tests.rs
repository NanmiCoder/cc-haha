use super::*;
use crate::tree::capabilities::text_units::LengthUnit;

#[test]
fn toolkit_policy_matrix() {
    let rows = [
        (
            Some("gtk"),
            Some("3.24.41"),
            [true, true, true, false, false, true, false],
        ),
        (
            Some("GTK"),
            Some("4.14.5"),
            [false, false, true, false, false, false, false],
        ),
        (
            Some("Qt"),
            Some("6.4"),
            [true, true, true, true, false, false, true],
        ),
        (
            Some("Chromium"),
            None,
            [true, false, true, false, false, false, false],
        ),
        (
            None,
            None,
            [false, false, false, false, false, false, false],
        ),
        (
            Some("gtk"),
            None,
            [false, false, false, false, false, false, false],
        ),
        (
            Some("gtk"),
            Some("x"),
            [false, false, false, false, false, false, false],
        ),
        (
            Some("clutter"),
            Some("1.0"),
            [false, false, false, false, false, false, false],
        ),
        (
            Some("Gecko"),
            Some("158.0"),
            [false, false, false, false, true, false, false],
        ),
    ];

    for (name, version, expected) in rows {
        let toolkit = ToolkitId {
            name: name.map(str::to_owned),
            version: version.map(str::to_owned),
        };
        let actual = [
            reports_global_position(&toolkit),
            trusts_same_window_landing(&toolkit),
            trusts_descent(&toolkit),
            insert_length_unit(&toolkit) == LengthUnit::Utf16Units,
            is_gecko(&toolkit),
            combo_selection_is_live(&toolkit),
            combo_name_is_value(&toolkit),
        ];
        assert_eq!(actual, expected, "toolkit {name:?} {version:?}");
    }
}
