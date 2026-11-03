use agent_desktop_core::AppError;
use serde_json::Value;

pub(super) fn html(data: &Value) -> Result<String, AppError> {
    let json = serde_json::to_string(data)?
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(include_str!("viewer.html")
        .replace("{{CSS}}", include_str!("viewer.css"))
        .replace(
            "{{JS}}",
            &format!(
                "{}\n{}",
                include_str!("viewer_filter.js"),
                include_str!("viewer.js")
            ),
        )
        .replace("{{DATA}}", &json))
}
