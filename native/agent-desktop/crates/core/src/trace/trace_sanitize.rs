use serde_json::{Value, json};

/// Recursively redacts fields whose keys match `SENSITIVE_KEYS`. Non-sensitive
/// fields and non-object values are left unchanged. Array elements are
/// recursively scanned. Used by both the file-trace writer and the FFI log
/// callback layer so that sensitive values never reach a consumer.
pub fn sanitize_trace_value(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    if is_sensitive_trace_key(&key) {
                        (key, redacted_value(value))
                    } else {
                        (key, sanitize_trace_value(value))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(sanitize_trace_value).collect()),
        other => other,
    }
}

fn is_sensitive_trace_key(key: &str) -> bool {
    const SENSITIVE_KEYS: &[&str] = &[
        "text",
        "value",
        "expected",
        "name",
        "username",
        "description",
        "label",
        "query",
        "selector",
        "secret",
        "token",
        "password",
        "title",
        "url",
        "help",
        "placeholder",
        "subrole",
        "dom",
        "classes",
        "body",
    ];
    const SENSITIVE_WHOLE_KEYS: &[&str] = &["actions", "key"];
    SENSITIVE_WHOLE_KEYS.contains(&key.to_ascii_lowercase().as_str())
        || trace_key_tokens(key)
            .iter()
            .any(|part| SENSITIVE_KEYS.contains(&part.as_str()))
}

fn trace_key_tokens(key: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous_was_lower_or_digit = false;
    let mut previous_was_uppercase = false;

    for ch in key.chars() {
        if !ch.is_ascii_alphanumeric() {
            push_trace_key_token(&mut tokens, &mut current);
            previous_was_lower_or_digit = false;
            previous_was_uppercase = false;
            continue;
        }

        if ch.is_ascii_uppercase() && previous_was_lower_or_digit {
            push_trace_key_token(&mut tokens, &mut current);
        }

        if ch.is_ascii_lowercase() && previous_was_uppercase && current.len() > 1 {
            if let Some(last) = current.pop() {
                push_trace_key_token(&mut tokens, &mut current);
                current.push(last);
            }
        }

        current.push(ch.to_ascii_lowercase());
        previous_was_lower_or_digit = ch.is_ascii_lowercase() || ch.is_ascii_digit();
        previous_was_uppercase = ch.is_ascii_uppercase();
    }

    push_trace_key_token(&mut tokens, &mut current);
    tokens
}

fn push_trace_key_token(tokens: &mut Vec<String>, current: &mut String) {
    if !current.is_empty() {
        tokens.push(std::mem::take(current));
    }
}

fn redacted_value(value: Value) -> Value {
    match value {
        Value::Null => Value::Null,
        _ => json!({ "redacted": true }),
    }
}

#[cfg(test)]
#[path = "trace_sanitize_tests.rs"]
mod tests;
