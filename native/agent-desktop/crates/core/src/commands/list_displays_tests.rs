use crate::{
    AdapterError, Rect,
    adapter::{ActionOps, InputOps, ObservationOps, SystemOps},
    commands::list_displays,
    system::display_info::DisplayInfo,
};

struct DisplayAdapter {
    displays: Vec<DisplayInfo>,
}

impl ObservationOps for DisplayAdapter {}
impl ActionOps for DisplayAdapter {}
impl InputOps for DisplayAdapter {}

impl SystemOps for DisplayAdapter {
    fn list_displays(&self, _deadline: crate::Deadline) -> Result<Vec<DisplayInfo>, AdapterError> {
        Ok(self.displays.clone())
    }
}

#[test]
fn list_displays_returns_adapter_displays() {
    let adapter = DisplayAdapter {
        displays: vec![DisplayInfo {
            id: "1".into(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
            },
            is_primary: true,
            scale: 2.0,
        }],
    };
    let value = list_displays::execute(&adapter).expect("list-displays");
    let displays = value.as_array().expect("list-displays returns an array");
    assert_eq!(displays.len(), 1);
    assert_eq!(displays[0]["id"], "1");
    assert_eq!(displays[0]["is_primary"], true);
    assert_eq!(displays[0]["scale"], 2.0);
    assert_eq!(displays[0]["bounds"]["width"], 1440.0);
    assert_eq!(displays[0]["bounds"]["height"], 900.0);
}

#[test]
fn default_trait_impl_returns_platform_not_supported() {
    struct Stub;
    impl ObservationOps for Stub {}
    impl ActionOps for Stub {}
    impl InputOps for Stub {}
    impl SystemOps for Stub {}

    let err = list_displays::execute(&Stub).expect_err("stub has no displays");
    assert_eq!(err.code(), "PLATFORM_NOT_SUPPORTED");
}
