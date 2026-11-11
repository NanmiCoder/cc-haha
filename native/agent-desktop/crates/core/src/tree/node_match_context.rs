use crate::AccessibilityNode;

pub struct NodeMatchContext<'a> {
    pub role: &'a str,
    pub name: Option<&'a str>,
    pub description: Option<&'a str>,
    pub native_id: Option<&'a str>,
    pub value: Option<&'a str>,
    pub states: &'a [String],
    pub children: &'a [AccessibilityNode],
}
