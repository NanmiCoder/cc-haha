use super::*;
use std::path::Path;

#[test]
fn output_path_creates_missing_parent_directories() {
    let root = output_path().with_extension("tree");
    let output = root.join("first").join("second").join("screenshot.png");
    let mut request = args();
    request.output_path = Some(output.clone());

    screenshot::execute(request, &ScreenshotAdapter::new()).expect("write into new directories");

    assert_eq!(std::fs::read(&output).expect("saved screenshot"), [1, 2, 3]);
    std::fs::remove_dir_all(root).expect("remove output tree");
}

fn refused_output_error(output: &Path) -> crate::AppError {
    let mut request = args();
    request.output_path = Some(output.to_path_buf());
    screenshot::execute(request, &ScreenshotAdapter::new())
        .expect_err("the output path cannot be written")
}

fn assert_refused_as_an_argument(error: crate::AppError, output: &Path) {
    assert_eq!(error.code(), "INVALID_ARGS");
    let crate::AppError::Adapter(error) = error else {
        panic!("an unwritable output path is an adapter error");
    };
    assert!(
        error.message.contains(&output.display().to_string()),
        "the message must name the path, got: {}",
        error.message
    );
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(error.disposition.retry(), crate::RetryDisposition::Safe);
    assert!(
        error
            .suggestion
            .as_deref()
            .is_some_and(|hint| hint.contains("path"))
    );
}

#[test]
fn a_file_in_place_of_the_parent_directory_is_an_argument_error_not_a_permission_denial() {
    let blocker = output_path().with_extension("blocker");
    std::fs::write(&blocker, b"in the way").expect("create blocker file");
    let output = blocker.join("screenshot.png");

    let error = refused_output_error(&output);
    std::fs::remove_file(&blocker).expect("remove blocker file");

    assert_refused_as_an_argument(error, &output);
}

#[test]
fn a_path_the_os_refuses_for_another_reason_is_an_argument_error_too() {
    let output = std::env::temp_dir().join("agent-desktop\0screenshot.png");

    assert_refused_as_an_argument(refused_output_error(&output), &output);
}
