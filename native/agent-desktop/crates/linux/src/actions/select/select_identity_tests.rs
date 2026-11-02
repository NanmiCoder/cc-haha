use super::*;

#[test]
fn a_reordered_row_is_refused_before_any_selection_write() {
    let mut rows = ['A', 'B'];
    let intended = rows[0];
    let saved_index = 0;
    rows.swap(0, 1);
    let mut writes = Vec::new();
    let result = with_current_row(Ok(rows[saved_index]), &intended, || {
        writes.push(rows[saved_index]);
        Ok(())
    });
    let error = result.expect_err("reordered row must be refused");
    assert_eq!(error.code, ErrorCode::StaleRef);
    assert_eq!(
        error.disposition,
        agent_desktop_core::DeliverySemantics::not_delivered()
    );
    assert!(writes.is_empty());
    assert_eq!(
        verification(None, Some(false), Some(&'B'), &'A'),
        Some(false)
    );
    assert_eq!(verification(None, None, Some(&'B'), &'A'), Some(false));
    assert_eq!(
        verification(Some(true), Some(false), Some(&'B'), &'A'),
        Some(false)
    );
    assert_eq!(
        verification(None, Some(false), Some(&'A'), &'A'),
        Some(true)
    );
}

#[test]
fn an_unreadable_row_refuses_writes_and_an_unchanged_row_allows_them() {
    let mut writes = 0;
    for observed in [Err(AdapterError::internal("unreadable")), Ok('A')] {
        let result = with_current_row(observed, &'A', || {
            writes += 1;
            Ok(())
        });
        if result.is_err() {
            assert_eq!(writes, 0);
        }
    }
    assert_eq!(writes, 1);
    assert_eq!(verification(None, Some(false), None, &'A'), Some(false));
    assert_eq!(verification(None, None, None, &'A'), None);
    assert_eq!(
        verification(Some(false), Some(true), Some(&'A'), &'A'),
        Some(false)
    );
}
