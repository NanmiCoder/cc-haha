type Environment = Vec<(&'static str, String)>;

pub(in crate::actions) fn qt_environment() -> (String, Environment) {
    let python = std::env::var("AGENT_DESKTOP_QT_PYTHON").unwrap_or_else(|_| "python3".to_owned());

    let environment = vec![
        ("QT_ACCESSIBILITY", "1".to_owned()),
        ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON", "1".to_owned()),
        ("QT_QPA_PLATFORM", "xcb".to_owned()),
    ];
    (python, environment)
}
