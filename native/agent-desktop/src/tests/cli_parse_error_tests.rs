use super::binary;

#[test]
fn clap_parse_failure_names_typed_subcommand() {
    let output = binary()
        .args(["list-windows", "--window-id", "x"])
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(envelope["command"], "list-windows");
}

#[test]
fn clap_parse_failure_finds_subcommand_after_global_option_and_value() {
    let output = binary()
        .args(["--timeout-ms", "37", "list-windows", "--window-id", "x"])
        .output()
        .expect("binary starts");
    let envelope: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");

    assert_eq!(output.status.code(), Some(2));
    assert_eq!(envelope["command"], "list-windows");
}
