use super::*;

#[test]
fn malformed_text_decodes_to_nothing() {
    for text in [
        "",
        "tray:",
        "tray:{",
        "tray:v1:item|:1.5|/p",
        "tray:{\"owner\":\":1.5\",\"menu_path\":null,\"entry_id\":null,\"label_path\":[]}",
        "tray:{\"object_path\":\"/p\",\"menu_path\":null,\"entry_id\":null,\"label_path\":[]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"/p\",\"menu_path\":null,\"entry_id\":null}",
        "tray:{\"owner\":\"\",\"object_path\":\"/p\",\"menu_path\":null,\"entry_id\":null,\"label_path\":[]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"relative\",\"menu_path\":null,\"entry_id\":null,\"label_path\":[]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"/p\",\"menu_path\":\"/m\",\"entry_id\":null,\"label_path\":[]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"/p\",\"menu_path\":null,\"entry_id\":3,\"label_path\":[\"Open\"]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"/p\",\"menu_path\":\"relative\",\"entry_id\":3,\"label_path\":[\"Open\"]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"/p\",\"menu_path\":\"/m\",\"entry_id\":3,\"label_path\":[]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"/p\",\"menu_path\":null,\"entry_id\":null,\"label_path\":[\"Open\"]}",
        "tray:{\"owner\":\":1.5\",\"object_path\":\"/p\",\"menu_path\":null,\"entry_id\":null,\"label_path\":[],\"extra\":true}",
        "/org/a11y/atspi/accessible/12",
    ] {
        assert_eq!(decode(text), None, "{text}");
    }
}
