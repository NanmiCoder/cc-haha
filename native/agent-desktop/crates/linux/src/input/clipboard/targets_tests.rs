use super::*;

fn offered(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn auto_prefers_an_image_over_text() {
    let list = offered(&["UTF8_STRING", "image/png"]);
    assert_eq!(
        choose_target(&list, ClipboardFormat::Auto),
        Some(Wanted::Image)
    );
}

#[test]
fn auto_with_only_text_picks_the_best_text_target() {
    let list = offered(&["STRING", "text/plain", "TARGETS"]);
    assert_eq!(
        choose_target(&list, ClipboardFormat::Auto),
        Some(Wanted::Text("text/plain"))
    );
    let both = offered(&["STRING", "UTF8_STRING"]);
    assert_eq!(
        choose_target(&both, ClipboardFormat::Text),
        Some(Wanted::Text("UTF8_STRING"))
    );
}

#[test]
fn only_bookkeeping_targets_pick_nothing() {
    let list = offered(&["TARGETS", "TIMESTAMP", "MULTIPLE"]);
    assert_eq!(choose_target(&list, ClipboardFormat::Auto), None);
}

#[test]
fn file_paths_fall_back_to_the_gnome_target() {
    let list = offered(&["x-special/gnome-copied-files"]);
    assert_eq!(
        choose_target(&list, ClipboardFormat::FileUrls),
        Some(Wanted::FileUrls(GNOME_FILES))
    );
}

#[test]
fn text_and_file_lists_decode_through_their_targets() {
    let text = content_of(&Wanted::Text("STRING"), vec![0xe9]).expect("text");
    assert!(matches!(text, ClipboardContent::Text(ref s) if s == "é"));
    let files =
        content_of(&Wanted::FileUrls(GNOME_FILES), b"cut\nfile:///a".to_vec()).expect("files");
    assert!(matches!(files, ClipboardContent::FileUrls(ref p) if p == &["/a".to_owned()]));
}
