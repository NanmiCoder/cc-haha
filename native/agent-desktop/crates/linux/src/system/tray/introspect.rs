const ITEM_SUFFIX: &str = "StatusNotifierItem";

fn attribute<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!("{name}=\"");
    let start = tag.find(&marker)? + marker.len();
    let rest = &tag[start..];
    Some(&rest[..rest.find('"')?])
}

/// The method names an item lists on its status notifier interface, read from
/// introspection XML. Methods of other interfaces are not the item's.
pub(crate) fn item_methods(xml: &str) -> Vec<String> {
    let mut methods = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<interface ") {
        let block = &rest[start..];
        let end = block.find("</interface>").unwrap_or(block.len());
        let body = &block[..end];
        let tag = &body[..body.find('>').unwrap_or(body.len())];
        if attribute(tag, "name").is_some_and(|name| name.ends_with(ITEM_SUFFIX)) {
            let mut scan = body;
            while let Some(at) = scan.find("<method ") {
                scan = &scan[at + "<method ".len()..];
                let tag = &scan[..scan.find('>').unwrap_or(scan.len())];
                if let Some(name) = attribute(tag, "name") {
                    methods.push(name.to_owned());
                }
            }
        }
        rest = &block[end..];
    }
    methods
}

#[cfg(test)]
#[path = "introspect_tests.rs"]
mod tests;
