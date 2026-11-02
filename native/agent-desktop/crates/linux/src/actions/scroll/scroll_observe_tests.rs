use std::cell::Cell;
use std::rc::Rc;

use super::*;

struct Virtual {
    now: Rc<Cell<Duration>>,
    lease: Duration,
}

impl Virtual {
    fn new(lease: Duration) -> (Self, Rc<Cell<Duration>>) {
        let now = Rc::new(Cell::new(Duration::ZERO));
        (
            Self {
                now: Rc::clone(&now),
                lease,
            },
            now,
        )
    }
}

impl Waiter for Virtual {
    fn elapsed(&self) -> Duration {
        self.now.get()
    }

    fn pause(&mut self, span: Duration) {
        self.now.set(self.now.get() + span);
    }

    fn remaining(&self) -> Duration {
        self.lease.saturating_sub(self.now.get())
    }
}

const STEP: Duration = Duration::from_millis(100);
const WINDOW: Duration = Duration::from_millis(2_000);

fn arrives_at(now: &Rc<Cell<Duration>>, at: Duration) -> Result<Option<bool>, AdapterError> {
    Ok(Some(now.get() < at))
}

#[test]
fn the_watch_never_outlasts_the_lease() {
    let (mut waiter, now) = Virtual::new(Duration::from_millis(500));
    let judged = realised(&mut waiter, WINDOW, STEP, || {
        arrives_at(&now, Duration::from_secs(60))
    });
    assert!(!judged.expect("the watch runs"));
    assert!(now.get() <= Duration::from_millis(500));
}

#[test]
fn the_first_look_is_immediate_and_unknown_is_not_on_screen() {
    let (mut waiter, now) = Virtual::new(Duration::from_secs(5));
    let mut looks = 0;
    let seen = realised(&mut waiter, WINDOW, STEP, || {
        looks += 1;
        Ok(if looks == 1 { Some(false) } else { None })
    });
    assert!(seen.expect("the watch runs"));
    assert_eq!(now.get(), Duration::ZERO);
    let (mut waiter, _) = Virtual::new(Duration::from_secs(5));
    let unknown = realised(&mut waiter, WINDOW, STEP, || Ok(None));
    assert!(!unknown.expect("the watch runs"));
}

#[test]
fn a_failed_look_ends_the_watch_with_its_error() {
    let (mut waiter, _) = Virtual::new(Duration::from_secs(5));
    let failed = realised(&mut waiter, WINDOW, STEP, || {
        Err(AdapterError::new(
            agent_desktop_core::ErrorCode::StaleRef,
            "gone",
        ))
    });
    assert!(failed.is_err());
}
