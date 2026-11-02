//! ActionResult / classifier error wire-shape parity pins (macOS structure).
//!
//! Hot-path cost baseline: A19-8 captures under
//! `probes/windows/19-semantic-actions/captures/semantic-cost-{devbox,ci}.json`.
//! Shared target pre-read baseline remains A18-7
//! (`probes/windows/18-actionability/captures/actionability-cost-*.json`).

/// Asserts the shared min/median/max/n/warmup_discarded shape of a
/// min-of-seven cost-capture arm (A15-13), for every arm name in `arms`.
/// Shared by `envelope_parity_tests.rs`'s semantic-action captures and
/// `input_envelope_parity_tests.rs`'s physical-input captures, which each
/// wrap this loop with their own schema-specific checks.
#[cfg(test)]
pub(crate) fn assert_cost_arms(label: &str, value: &serde_json::Value, arms: &[&str]) {
    for arm in arms {
        let entry = value
            .get(*arm)
            .unwrap_or_else(|| panic!("{label} missing arm {arm}"));
        let min = entry["min_ms"]
            .as_f64()
            .unwrap_or_else(|| panic!("{label}/{arm} missing min_ms"));
        let median = entry["median_ms"]
            .as_f64()
            .unwrap_or_else(|| panic!("{label}/{arm} missing median_ms"));
        let max = entry["max_ms"]
            .as_f64()
            .unwrap_or_else(|| panic!("{label}/{arm} missing max_ms"));
        assert!(
            min <= median && median <= max,
            "{label}/{arm}: min<=median<=max ({min}, {median}, {max})"
        );
        assert_eq!(entry["n"], 7, "{label}/{arm} n");
        assert_eq!(
            entry["warmup_discarded"], true,
            "{label}/{arm} warmup_discarded"
        );
    }
}

#[cfg(test)]
#[path = "envelope_parity_tests.rs"]
mod tests;
