use super::*;

#[test]
fn image_out_path_inside_a_file_is_an_argument_error() {
    let blocker = std::env::temp_dir().join(format!("clipboard-blocker-{}", std::process::id()));
    std::fs::write(&blocker, b"file").unwrap();
    let out_path = blocker.join("image.png");
    let double = LocalDouble::returning(Ok(Some(ClipboardContent::Image(ImageBuffer {
        data: vec![1, 2, 3],
        format: crate::ImageFormat::Png,
        width: 1,
        height: 1,
        scale_factor: 1.0,
    }))));

    let error = execute(
        ClipboardGetArgs {
            format: Some(ClipboardFormat::Image),
            out: Some(out_path.clone()),
        },
        &double,
        &no_session_context(),
    )
    .unwrap_err();
    std::fs::remove_file(&blocker).unwrap();

    assert_eq!(error.code(), "INVALID_ARGS");
    assert!(error.to_string().contains(&format!(
        "Cannot write the clipboard content to '{}'",
        out_path.display()
    )));
    let crate::AppError::Adapter(error) = error else {
        panic!("expected structured argument error")
    };
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    assert_eq!(error.disposition.retry(), crate::RetryDisposition::Safe);
    assert!(error.suggestion.is_some());
}
