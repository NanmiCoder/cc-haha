use super::*;

#[test]
fn rejects_unknown_direction() {
    assert_eq!(
        parse_direction("sideways").unwrap_err().code(),
        "INVALID_ARGS"
    );
}

#[test]
fn env_parse_errors_never_echo_the_value() {
    let secret = "sk_live_supersecret_token_value";
    let no_equals = parse_env_pair(secret, 0).unwrap_err();
    let no_equals_msg = no_equals.to_string();
    assert_eq!(no_equals.code(), "INVALID_ARGS");
    assert!(
        !no_equals_msg.contains(secret),
        "malformed --env message leaked the raw value: {no_equals_msg}"
    );

    let empty_key = format!("={secret}");
    let err = parse_env_pair(&empty_key, 3).unwrap_err();
    let err_msg = err.to_string();
    assert_eq!(err.code(), "INVALID_ARGS");
    assert!(
        !err_msg.contains(secret),
        "empty-key --env message leaked the raw value: {err_msg}"
    );
    assert!(
        err_msg.contains("#3"),
        "message should carry the entry index"
    );
}

#[test]
fn rejects_unknown_get_property() {
    match parse_get_property("placeholder") {
        Ok(_) => panic!("expected invalid get property"),
        Err(err) => assert_eq!(err.code(), "INVALID_ARGS"),
    }
}

#[test]
fn rejects_unknown_is_property() {
    match parse_is_property("placeholder") {
        Ok(_) => panic!("expected invalid is property"),
        Err(err) => assert_eq!(err.code(), "INVALID_ARGS"),
    }
}

#[test]
fn parses_selected_is_property() {
    assert!(parse_is_property("selected").is_ok());
}

#[test]
fn rejects_unknown_mouse_button() {
    assert_eq!(
        parse_mouse_button("primary").unwrap_err().code(),
        "INVALID_ARGS"
    );
}

#[test]
fn parses_xy_with_whitespace() {
    assert_eq!(parse_xy(" 10.5, 20 ").unwrap(), (10.5, 20.0));
}

#[test]
fn rejects_bad_xy_shape_and_numbers() {
    assert_eq!(parse_xy("10").unwrap_err().code(), "INVALID_ARGS");
    assert_eq!(parse_xy("x,20").unwrap_err().code(), "INVALID_ARGS");
    assert_eq!(parse_xy("10,y").unwrap_err().code(), "INVALID_ARGS");
    assert_eq!(parse_xy("1,2,3").unwrap_err().code(), "INVALID_ARGS");
    assert_eq!(parse_xy("NaN,20").unwrap_err().code(), "INVALID_ARGS");
    assert_eq!(parse_xy("10,inf").unwrap_err().code(), "INVALID_ARGS");
}

#[test]
fn rejects_duplicate_modifiers() {
    let error = parse_modifiers(&["shift".into(), "shift".into()])
        .expect_err("duplicate modifier must not be silently applied twice");
    assert_eq!(error.code(), "INVALID_ARGS");
}

#[test]
fn modifier_aliases_map_to_portable_meta() {
    for alias in ["meta", "cmd", "command", "super", "win", "META"] {
        assert_eq!(parse_modifier(alias).unwrap(), Modifier::Meta);
    }
}

#[test]
fn launch_options_reject_ambiguous_or_nonportable_environment() {
    let duplicate = build_launch_options(&launch_args(&[], &["A=1".into(), "A=2".into()]))
        .expect_err("duplicate keys must not silently overwrite");
    assert_eq!(duplicate.code(), "INVALID_ARGS");

    for entry in ["9KEY=value", "BAD-KEY=value", "KEY=bad\0value"] {
        assert_eq!(parse_env_pair(entry, 0).unwrap_err().code(), "INVALID_ARGS");
    }
    let nul_arg = build_launch_options(&launch_args(&["bad\0arg".into()], &[]))
        .expect_err("NUL arguments must fail before platform spawn");
    assert_eq!(nul_arg.code(), "INVALID_ARGS");
}

fn launch_args(args: &[String], env: &[String]) -> crate::cli_args::system::LaunchArgs {
    crate::cli_args::system::LaunchArgs {
        app: "Fixture".into(),
        timeout: 100,
        args: args.to_vec(),
        env: env.to_vec(),
        cwd: None,
        no_attach: false,
        activate: false,
        cdp: None,
    }
}
