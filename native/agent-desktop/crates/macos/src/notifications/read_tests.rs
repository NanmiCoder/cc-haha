use agent_desktop_core::AdapterError;

#[test]
fn title_fallback_is_lazy_when_title_is_present() {
    let mut attributes = Vec::new();
    let value = super::title_or_description_with(|attribute: &str| {
        attributes.push(attribute.to_owned());
        match attribute {
            "AXTitle" => Ok(Some("Close".to_owned())),
            _ => Err(AdapterError::internal("description must not be read")),
        }
    })
    .expect("title read");

    assert_eq!(value.as_deref(), Some("Close"));
    assert_eq!(attributes, ["AXTitle"]);
}
