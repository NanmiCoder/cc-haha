use super::*;

fn parse(text: &str) -> Vec<String> {
    parse_uri_list(text.as_bytes()).expect("a well formed list")
}

#[test]
fn percent_sequences_decode_to_the_path() {
    assert_eq!(parse("file:///a%20b/c.txt"), ["/a b/c.txt"]);
    assert_eq!(parse("file:///caf%C3%A9"), ["/café"]);
}

#[test]
fn an_empty_or_localhost_host_is_accepted() {
    assert_eq!(parse("file://localhost/x"), ["/x"]);
    assert_eq!(parse("file:///y"), ["/y"]);
}

#[test]
fn remote_hosts_other_schemes_and_comments_are_skipped() {
    let list = "# a comment\r\nfile://otherhost/x\r\nhttp://x/y\r\nfile:///kept\r\n";
    assert_eq!(parse(list), ["/kept"]);
}

#[test]
fn crlf_and_lf_both_split() {
    assert_eq!(
        parse("file:///a\r\nfile:///b\nfile:///c"),
        ["/a", "/b", "/c"]
    );
}

#[test]
fn an_invalid_percent_sequence_is_an_error() {
    for bad in ["file:///a%zz", "file:///a%2", "file:///a%"] {
        let error = parse_uri_list(bad.as_bytes()).expect_err(bad);
        assert_eq!(error.code, ErrorCode::ActionFailed, "{bad}");
    }
}

#[test]
fn a_decoded_path_that_is_not_utf8_is_an_error() {
    assert!(parse_uri_list(b"file:///a%FF").is_err());
}

#[test]
fn encoding_escapes_space_hash_and_non_ascii_and_ends_each_line_in_crlf() {
    let encoded = encode_uri_list(&["/tmp/a b/é #1.txt".to_owned()]);
    assert_eq!(
        String::from_utf8(encoded).expect("ascii"),
        "file:///tmp/a%20b/%C3%A9%20%231.txt\r\n"
    );
}

#[test]
fn encoded_paths_decode_back_including_a_newline_and_a_percent() {
    let paths = vec![
        "/tmp/a b/é #1.txt".to_owned(),
        "/tmp/new\nline%x".to_owned(),
    ];
    let encoded = encode_uri_list(&paths);
    assert!(String::from_utf8_lossy(&encoded).contains("%0A"));
    assert_eq!(parse_uri_list(&encoded).expect("round trip"), paths);
}

#[test]
fn gnome_files_parse_copy_cut_and_a_missing_header() {
    for text in [
        "copy\nfile:///a\nfile:///b",
        "cut\nfile:///a\nfile:///b",
        "file:///a\nfile:///b",
        "copy\r\nfile:///a\r\nfile:///b\r\n",
    ] {
        assert_eq!(
            parse_gnome_copied_files(text.as_bytes()).expect(text),
            ["/a", "/b"],
            "{text:?}"
        );
    }
}
