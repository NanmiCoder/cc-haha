use super::*;

struct LiveValue(Option<String>);

impl ObservationOps for LiveValue {
    fn resolve_element_strict(
        &self,
        _entry: &RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn get_live_value(
        &self,
        _handle: &NativeHandle,
        _deadline: crate::Deadline,
    ) -> Result<Option<String>, AdapterError> {
        Ok(self.0.clone())
    }
}

impl ActionOps for LiveValue {}
impl InputOps for LiveValue {}
impl SystemOps for LiveValue {}

#[test]
fn get_value_does_not_resurrect_snapshot_text_when_live_value_is_absent() {
    let _guard = HomeGuard::new();
    let snapshot = save_entry(entry(vec![], Some("old text"), vec![]));
    let mut field = entry(vec![], Some("old text"), vec![]);
    field.identity.role = "textfield".into();
    let field_snapshot = save_entry(field);
    for (live, field_text) in [
        (None, "Target"),
        (Some(String::new()), "Target"),
        (Some("new text".to_string()), "new text"),
    ] {
        let adapter = LiveValue(live.clone());
        assert_eq!(
            get_property(&snapshot, &adapter, GetProperty::Value).unwrap()["value"],
            json!(live)
        );
        assert_eq!(
            get_property(&snapshot, &adapter, GetProperty::Text).unwrap()["value"],
            "Target"
        );
        assert_eq!(
            get_property(&field_snapshot, &adapter, GetProperty::Text).unwrap()["value"],
            field_text
        );
    }
    assert_eq!(
        get_property(
            &snapshot,
            &LiveStateAdapter::without_live_support(),
            GetProperty::Value
        )
        .unwrap()["value"],
        "old text"
    );
}
