use super::*;
use agent_desktop_core::CursorImage;

fn style_with(image: Option<&str>, size: f64) -> CursorOverlayStyle {
    let mut style = CursorOverlayStyle::default();
    style.set_size(size);
    style.set_image(image.map(|path| {
        CursorImage::new(path.to_owned(), Point { x: 4.0, y: 2.0 }).expect("valid image")
    }));
    style
}

fn enable(style: CursorOverlayStyle) -> CursorOverlayControl {
    CursorOverlayControl::enable("run".into(), style)
}

#[test]
fn only_an_image_change_triggers_a_native_reload() {
    let mut state = OverlayState::default();
    assert_eq!(
        absorb_style(&enable(style_with(None, 1.0)), &mut state),
        Some(false)
    );
    assert_eq!(
        absorb_style(&enable(style_with(Some("/tmp/a.png"), 1.0)), &mut state),
        Some(true)
    );
    assert_eq!(
        absorb_style(&enable(style_with(Some("/tmp/a.png"), 2.0)), &mut state),
        Some(false)
    );
    assert_eq!(state.style.size(), 2.0);
    assert_eq!(
        absorb_style(&enable(style_with(Some("/tmp/b.png"), 2.0)), &mut state),
        Some(true)
    );
    assert_eq!(
        absorb_style(&CursorOverlayControl::show("run".into()), &mut state),
        None
    );
    assert!(state.style.image().is_some());
    assert_eq!(
        absorb_style(&enable(style_with(None, 2.0)), &mut state),
        Some(true)
    );
    assert_eq!(state.style.image(), None);
}

#[test]
fn a_pointer_image_change_also_triggers_a_native_reload() {
    let mut state = OverlayState::default();
    let arrow = style_with(Some("/tmp/a.png"), 1.0);
    assert_eq!(absorb_style(&enable(arrow.clone()), &mut state), Some(true));
    let mut with_pointer = arrow.clone();
    with_pointer.set_pointer_image(Some(
        CursorImage::new("/tmp/hand.png".into(), Point { x: 7.0, y: 0.0 }).expect("valid image"),
    ));
    assert_eq!(
        absorb_style(&enable(with_pointer.clone()), &mut state),
        Some(true)
    );
    assert_eq!(absorb_style(&enable(with_pointer), &mut state), Some(false));
    assert_eq!(absorb_style(&enable(arrow), &mut state), Some(true));
    assert_eq!(state.style.pointer_image(), None);
}
