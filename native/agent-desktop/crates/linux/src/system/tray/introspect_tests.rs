use super::*;

const KDE_STYLE: &str = r#"<node>
  <interface name="org.freedesktop.DBus.Introspectable">
    <method name="Introspect"><arg type="s" direction="out"/></method>
  </interface>
  <interface name="org.kde.StatusNotifierItem">
    <method name="ContextMenu"><arg type="i" name="x" direction="in"/></method>
    <method name="Activate"><arg type="i" name="x" direction="in"/></method>
    <method name="SecondaryActivate"/>
    <method name="Scroll"/>
    <signal name="NewTitle"/>
    <property name="Title" type="s" access="read"/>
  </interface>
</node>"#;

const AYATANA_STYLE: &str = r#"<node>
  <interface name="org.kde.StatusNotifierItem">
    <method name="Scroll"/>
    <method name="SecondaryActivate"/>
    <method name="XAyatanaSecondaryActivate"/>
  </interface>
</node>"#;

#[test]
fn the_methods_of_the_item_interface_are_listed_in_order() {
    assert_eq!(
        item_methods(KDE_STYLE),
        ["ContextMenu", "Activate", "SecondaryActivate", "Scroll"]
    );
}

#[test]
fn an_item_listing_no_activate_lists_the_secondary_methods_only() {
    assert_eq!(
        item_methods(AYATANA_STYLE),
        ["Scroll", "SecondaryActivate", "XAyatanaSecondaryActivate"]
    );
}

#[test]
fn xml_without_the_item_interface_lists_nothing() {
    assert!(item_methods("<node/>").is_empty());
    assert!(item_methods("").is_empty());
    assert!(item_methods("<interface name=\"org.kde.StatusNotifierItem\"").is_empty());
}
