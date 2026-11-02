use super::{
    child_read::ChildRead, child_read_status::ChildReadStatus,
    child_source_availability::ChildSourceAvailability,
};

const CANONICAL_CHILDREN: &str = "AXChildren";
const READ_ATTEMPTS: usize = 3;

pub(crate) fn read_resilient(
    attributes: &[&str],
    deadline: std::time::Instant,
    mut read_attribute: impl FnMut(&str) -> ChildRead,
) -> ChildRead {
    let mut status = ChildReadStatus::default();
    let mut attempt = 0;
    loop {
        let mut read = read_first_nonempty(attributes, &mut read_attribute);
        attempt += 1;
        let retry = !read.complete
            && !read.status.invalid_element
            && !read.status.api_disabled
            && attempt < READ_ATTEMPTS
            && std::time::Instant::now() < deadline;
        status.merge(std::mem::take(&mut read.status));
        if !retry {
            read.status = status;
            return read;
        }
        std::thread::sleep(
            deadline
                .saturating_duration_since(std::time::Instant::now())
                .min(std::time::Duration::from_millis(1)),
        );
    }
}

pub(super) fn read_first_nonempty(
    attributes: &[&str],
    mut read_attribute: impl FnMut(&str) -> ChildRead,
) -> ChildRead {
    let mut status = ChildReadStatus::default();
    let mut prefix_certain = true;
    let mut any_available = false;
    for attribute in attributes {
        let mut read = read_attribute(attribute);
        let terminal = read.status.invalid_element || read.status.api_disabled;
        any_available |= read.source_availability == ChildSourceAvailability::Available;
        status.merge(read.status);
        let source_selected = read.source_availability == ChildSourceAvailability::Available
            && (read.total_count > 0 || *attribute == CANONICAL_CHILDREN);
        if source_selected {
            read.prefix_certain &= prefix_certain;
            read.complete &= read.prefix_certain;
            read.status = status;
            return read;
        }
        prefix_certain &= read.prefix_certain;
        if terminal {
            break;
        }
    }
    ChildRead {
        elements: Vec::new(),
        total_count: 0,
        complete: prefix_certain,
        source_availability: if any_available {
            ChildSourceAvailability::Available
        } else if prefix_certain {
            ChildSourceAvailability::Unavailable
        } else {
            ChildSourceAvailability::Unknown
        },
        prefix_certain,
        status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::AXElement;

    fn read(count: usize, complete: bool, availability: ChildSourceAvailability) -> ChildRead {
        ChildRead {
            elements: (count > 0)
                .then(|| AXElement(std::ptr::null_mut()))
                .into_iter()
                .collect(),
            total_count: count,
            complete,
            source_availability: availability,
            prefix_certain: complete,
            status: ChildReadStatus::default(),
        }
    }

    #[test]
    fn successful_empty_children_stops_fallbacks_as_complete() {
        let mut attributes = Vec::new();
        let selected = read_first_nonempty(&["AXChildren", "AXContents"], |attribute| {
            attributes.push(attribute.to_string());
            read(0, true, ChildSourceAvailability::Available)
        });

        assert_eq!(attributes, ["AXChildren"]);
        assert!(selected.elements.is_empty());
        assert!(selected.complete);
    }

    #[test]
    fn unsupported_children_reaches_contents() {
        let mut attributes = Vec::new();
        let selected = read_first_nonempty(&["AXChildren", "AXContents"], |attribute| {
            attributes.push(attribute.to_string());
            if attribute == "AXChildren" {
                read(0, true, ChildSourceAvailability::Unavailable)
            } else {
                read(1, true, ChildSourceAvailability::Available)
            }
        });

        assert_eq!(attributes, ["AXChildren", "AXContents"]);
        assert_eq!(selected.elements.len(), 1);
        assert!(selected.complete);
    }

    #[test]
    fn failed_children_poisons_nonempty_fallback() {
        let selected = read_first_nonempty(&["AXChildren", "AXContents"], |attribute| {
            if attribute == "AXChildren" {
                let mut failed = read(0, false, ChildSourceAvailability::Unknown);
                failed.status.health.native_read_failures = 1;
                failed
            } else {
                read(1, true, ChildSourceAvailability::Available)
            }
        });

        assert_eq!(selected.elements.len(), 1);
        assert!(!selected.complete);
        assert_eq!(selected.status.health.native_read_failures, 1);
    }

    #[test]
    fn partial_nonempty_primary_stops_fallback_and_remains_incomplete() {
        let mut attributes = Vec::new();
        let selected = read_first_nonempty(&["AXChildren", "AXContents"], |attribute| {
            attributes.push(attribute.to_string());
            read(1, false, ChildSourceAvailability::Available)
        });

        assert_eq!(attributes, ["AXChildren"]);
        assert_eq!(selected.elements.len(), 1);
        assert!(!selected.complete);
    }

    #[test]
    fn resilient_read_recovers_after_two_incomplete_attempts() {
        let mut attempts = 0;
        let selected = read_resilient(
            &["AXChildren"],
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            |_| {
                attempts += 1;
                read(1, attempts == 3, ChildSourceAvailability::Available)
            },
        );

        assert_eq!(attempts, 3);
        assert!(selected.complete);
    }

    #[test]
    fn resilient_read_stops_cleanly_after_three_incomplete_attempts() {
        let mut attempts = 0;
        let selected = read_resilient(
            &["AXChildren"],
            std::time::Instant::now() + std::time::Duration::from_secs(1),
            |_| {
                attempts += 1;
                read(0, false, ChildSourceAvailability::Unknown)
            },
        );

        assert_eq!(attempts, 3);
        assert!(!selected.complete);
    }

    #[test]
    fn window_surface_recovers_without_losing_read_failure_evidence() {
        let mut attempts = 0;
        let selected = read_resilient(
            &["AXWindows"],
            std::time::Instant::now() + std::time::Duration::from_secs(60),
            |attribute| {
                assert_eq!(attribute, "AXWindows");
                attempts += 1;
                if attempts == 1 {
                    let mut failed = read(0, false, ChildSourceAvailability::Unknown);
                    failed.status.health.cannot_complete = 1;
                    failed
                } else {
                    read(1, true, ChildSourceAvailability::Available)
                }
            },
        );
        assert_eq!(attempts, 2);
        assert!(selected.complete);
        assert_eq!(selected.elements.len(), 1);
        assert_eq!(selected.status.health.cannot_complete, 1);
    }

    #[test]
    fn window_surface_does_not_retry_terminal_or_complete_reads() {
        for outcome in ["empty", "permission", "invalid", "expired"] {
            let mut attempts = 0;
            let deadline = std::time::Instant::now()
                + std::time::Duration::from_secs(if outcome == "expired" { 0 } else { 60 });
            let selected = read_resilient(&["AXWindows"], deadline, |_| {
                attempts += 1;
                let mut result = read(
                    0,
                    outcome == "empty",
                    if outcome == "empty" {
                        ChildSourceAvailability::Available
                    } else {
                        ChildSourceAvailability::Unknown
                    },
                );
                result.status.api_disabled = outcome == "permission";
                result.status.invalid_element = outcome == "invalid";
                result
            });
            assert_eq!(attempts, 1, "{outcome}");
            assert_eq!(selected.complete, outcome == "empty", "{outcome}");
            assert_eq!(selected.status.api_disabled, outcome == "permission");
            assert_eq!(selected.status.invalid_element, outcome == "invalid");
        }
    }
}
