use super::*;

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

fn run(exec: &str, arguments: &[&str]) -> Vec<String> {
    let arguments = strings(arguments);
    expand(
        exec,
        &ExecContext {
            arguments: &arguments,
            icon: None,
            name: "App Name",
            file: Some("/usr/share/applications/app.desktop"),
        },
    )
}

#[test]
fn exec_lines_expand_to_the_expected_argv() {
    let cases: &[(&str, &[&str], &[&str])] = &[
        (
            "gnome-text-editor --gapplication-service %U",
            &["/a.txt", "/b.txt"],
            &[
                "gnome-text-editor",
                "--gapplication-service",
                "/a.txt",
                "/b.txt",
            ],
        ),
        (
            "gnome-text-editor --gapplication-service %U",
            &[],
            &["gnome-text-editor", "--gapplication-service"],
        ),
        (
            "\"/opt/My App/run\" --flag %f",
            &[],
            &["/opt/My App/run", "--flag"],
        ),
        ("tool \"say \\\"hi\\\"\"", &[], &["tool", "say \"hi\""]),
        ("tool 100%%f", &[], &["tool", "100%f"]),
        (
            "tool --title=%c %k",
            &[],
            &[
                "tool",
                "--title=App Name",
                "/usr/share/applications/app.desktop",
            ],
        ),
        ("tool %d %D %n %N %v %m %z a", &[], &["tool", "a"]),
        (
            "tool --serve",
            &["--port=1", "/a.txt"],
            &["tool", "--serve", "--port=1", "/a.txt"],
        ),
        (
            "viewer %F --tail",
            &["/1", "/2", "/3"],
            &["viewer", "/1", "/2", "/3", "--tail"],
        ),
        ("viewer %U --tail", &["/1"], &["viewer", "/1", "--tail"]),
        ("viewer %f", &["/1", "/2"], &["viewer", "/1", "/2"]),
        (
            "chromium %U",
            &["--user-data-dir", "/tmp/p", "--new-window", "https://x"],
            &[
                "chromium",
                "--user-data-dir",
                "/tmp/p",
                "--new-window",
                "https://x",
            ],
        ),
        (
            "tool --serve",
            &["--port=1", "/a.txt", "--flag"],
            &["tool", "--serve", "--port=1", "/a.txt", "--flag"],
        ),
        (
            "viewer %F",
            &["--", "-odd.txt"],
            &["viewer", "--", "-odd.txt"],
        ),
        (
            "viewer %F",
            &["-a", "--", "-odd.txt"],
            &["viewer", "-a", "--", "-odd.txt"],
        ),
        (
            "sh -c \"cat %f\"",
            &["; rm -rf /"],
            &["sh", "-c", "cat ", "; rm -rf /"],
        ),
        ("tool \"\" x", &[], &["tool", "", "x"]),
    ];

    for (exec, arguments, expected) in cases {
        assert_eq!(run(exec, arguments), strings(expected), "{exec}");
    }
}

#[test]
fn icon_field_code_requires_an_icon() {
    let with = expand(
        "tool %i",
        &ExecContext {
            arguments: &[],
            icon: Some("org.app"),
            name: "n",
            file: None,
        },
    );
    assert_eq!(with, strings(&["tool", "--icon", "org.app"]));
    assert_eq!(run("tool %i", &[]), strings(&["tool"]));
}

#[test]
fn program_word_skips_env_setup_and_field_codes() {
    assert_eq!(
        program_word("env FOO=1 /opt/app/bin/tool %f").as_deref(),
        Some("/opt/app/bin/tool")
    );
    assert_eq!(
        program_word("nautilus --new-window %U").as_deref(),
        Some("nautilus")
    );
    assert_eq!(program_word("%f"), None);
    assert_eq!(program_word(""), None);
}
