pub(crate) fn normalize(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if is_bidirectional_control(character) {
            continue;
        }
        if character.is_whitespace() {
            pending_space = !normalized.is_empty();
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        if character.is_ascii() {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.extend(character.to_lowercase());
        }
    }
    normalized
}

pub(crate) fn is_bidirectional_control(character: char) -> bool {
    matches!(
        character,
        '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
    )
}

pub(crate) fn contains(haystack: &str, normalized_needle: &str) -> bool {
    if normalized_needle.is_empty() {
        return true;
    }
    normalize(haystack).contains(normalized_needle)
}

pub(crate) fn node_contains(node: &crate::AccessibilityNode, normalized_needle: &str) -> bool {
    [
        node.identity.name.as_deref(),
        node.identity.value.as_deref(),
        node.identity.description.as_deref(),
    ]
    .into_iter()
    .flatten()
    .any(|text| contains(text, normalized_needle))
}

#[cfg(test)]
#[path = "search_text_tests.rs"]
mod tests;
