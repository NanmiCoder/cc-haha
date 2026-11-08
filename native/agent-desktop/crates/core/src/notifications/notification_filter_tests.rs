use crate::NotificationFilter;

#[test]
fn default_is_unfiltered() {
    let filter = NotificationFilter::default();
    assert!(filter.app.is_none());
    assert!(filter.text.is_none());
    assert!(filter.limit.is_none());
}
