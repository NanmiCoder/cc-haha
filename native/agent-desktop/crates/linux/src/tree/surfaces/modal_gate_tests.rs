use std::time::Duration;

use super::*;

fn spent() -> Deadline {
    let deadline = Deadline::after(1).expect("deadline");
    std::thread::sleep(Duration::from_millis(5));
    deadline
}

#[test]
fn a_walk_the_deadline_cut_short_is_the_timeout_not_an_unknown_modal_state() {
    let error = cut_short(spent());
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(error.details.expect("details")["kind"], "deadline");
}

#[test]
fn a_walk_cut_short_with_budget_left_could_not_establish_the_modal_state() {
    let error = cut_short(Deadline::after(60_000).expect("deadline"));
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        error.details.expect("details")["cause"],
        "modal_state_unknown"
    );
}

#[test]
fn an_unanswered_read_is_the_timeout_only_once_the_deadline_has_passed() {
    let unanswered = || AdapterError::timeout("window did not answer");
    assert_eq!(unreadable(unanswered(), spent()).code, ErrorCode::Timeout);
    let live = unreadable(unanswered(), Deadline::after(60_000).expect("deadline"));
    assert_eq!(live.code, ErrorCode::ActionFailed);
    assert_eq!(
        live.details.expect("details")["cause"],
        "modal_state_unknown"
    );
}
