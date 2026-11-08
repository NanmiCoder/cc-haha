use std::collections::BTreeMap;

use crate::tree::Field;

pub(crate) type AttributeRead = Field<BTreeMap<String, String>>;

/// The attribute's value when the read succeeded and the value is not blank.
pub(crate) fn non_blank<'a>(attributes: &'a AttributeRead, key: &str) -> Option<&'a str> {
    attributes
        .present()?
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

pub(crate) fn has_key(attributes: &AttributeRead, key: &str) -> bool {
    attributes
        .present()
        .is_some_and(|map| map.contains_key(key))
}

/// The first whitespace-separated token of the `xml-roles` attribute.
pub(crate) fn first_xml_role(attributes: &AttributeRead) -> Option<String> {
    non_blank(attributes, "xml-roles")?
        .split_whitespace()
        .next()
        .map(str::to_ascii_lowercase)
}
