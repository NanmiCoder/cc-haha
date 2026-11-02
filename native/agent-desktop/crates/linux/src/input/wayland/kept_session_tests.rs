use std::time::Duration;

use super::{Pool, Taken};

#[test]
fn a_recent_value_comes_back_once() {
    let pool = Pool::new();
    pool.put(7);

    assert!(matches!(pool.take(Duration::from_secs(5)), Taken::Fresh(7)));
    assert!(matches!(pool.take(Duration::from_secs(5)), Taken::Empty));
}

#[test]
fn an_idle_value_comes_back_as_expired_so_its_session_can_be_stopped() {
    let pool = Pool::new();
    pool.put(7);
    std::thread::sleep(Duration::from_millis(30));

    assert!(matches!(
        pool.take(Duration::from_millis(10)),
        Taken::Expired(7)
    ));
}

#[test]
fn taking_with_no_idle_allowance_hands_back_whatever_is_kept_so_the_process_can_stop_it() {
    let pool = Pool::new();
    pool.put(7);

    assert!(matches!(pool.take(Duration::ZERO), Taken::Expired(7)));
    assert!(matches!(pool.take(Duration::ZERO), Taken::Empty));
}
