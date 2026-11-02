use super::*;

const NOTEPAD: &str = include_str!("testdata/notepad-com.json");
const EXPLORER: &str = include_str!("testdata/explorer-com.json");

fn captures() -> [(&'static str, &'static str); 2] {
    [(CAPTURE_FILES[0], NOTEPAD), (CAPTURE_FILES[1], EXPLORER)]
}

/// The redaction rule, not the contents. A capture that still carries a raw
/// process id, provider id, window handle or user path publishes a fingerprint
/// of the machine that produced it, and a partial substitution is worse than
/// none because it reads as redacted.
#[test]
fn no_committed_capture_leaks_a_host_identifier() {
    for (name, body) in captures() {
        for (key, placeholder) in [("pid:", "<pid>"), ("providerId:", "<providerid>")] {
            for occurrence in body.split(key).skip(1) {
                assert!(
                    occurrence.starts_with(placeholder),
                    "{name} leaks a value after {key}: {}",
                    &occurrence[..occurrence.len().min(24)]
                );
            }
        }
        assert!(
            !body.to_ascii_lowercase().contains(r"\users\"),
            "{name} carries a user-profile path"
        );
        assert!(
            !body.to_ascii_lowercase().contains("hwnd:0x"),
            "{name} carries a raw window handle"
        );
    }
}

/// The metadata whose absence made the earlier managed-stack dumps unusable
/// as COM expectations.
#[test]
fn every_committed_capture_records_its_variant_build_and_stack() {
    for (name, body) in captures() {
        let document: serde_json::Value =
            serde_json::from_str(body).unwrap_or_else(|_| panic!("{name} is valid JSON"));
        for field in ["target_variant", "os_build", "client_stack", "crate"] {
            let value = document
                .get(field)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            assert!(!value.is_empty(), "{name} does not record {field}");
        }
        assert_eq!(document["client_stack"], "uia3-com");
    }
}

/// A capture that resolved nothing is not evidence. The tool reports an
/// unresolvable target as a structured skip with a non-zero exit instead, so a
/// committed capture always holds a tree the walker actually reached.
#[test]
fn no_committed_capture_is_an_empty_tree() {
    for (name, body) in captures() {
        let document: serde_json::Value =
            serde_json::from_str(body).unwrap_or_else(|_| panic!("{name} is valid JSON"));
        assert!(
            document["node_count"].as_u64().unwrap_or_default() > 0,
            "{name} records no nodes, which reads as evidence that the tree was empty"
        );
        assert!(
            document.get("walk").is_some(),
            "{name} records no walk verdict"
        );
        for census in ["control_types", "providers", "sample"] {
            assert!(
                document[census]
                    .as_array()
                    .is_some_and(|rows| !rows.is_empty()),
                "{name} records an empty {census} census"
            );
        }
    }
}
