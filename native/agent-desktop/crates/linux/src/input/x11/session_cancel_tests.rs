use std::sync::{Arc, mpsc::channel};
use std::thread;
use std::time::Duration;

use agent_desktop_core::DeliverySemantics;

use super::abandoned;
use crate::input::plan::Plan;
use crate::input::step::Step;
use crate::input::x11::fake_sink::{FakeSink, Recorded, deadline, events};
use crate::input::x11::progress::Progress;
use crate::input::x11::worker::{self, Link};

#[test]
fn a_timeout_during_the_first_send_never_reports_safe_to_retry() {
    let fake = FakeSink::new();
    let sink = fake.clone();
    let (ready, resume) = fake.block_next_event();
    let progress = Arc::new(Progress::default());
    let worker_progress = Arc::clone(&progress);
    let (reports, inbox) = channel();
    let (proceed_tx, proceed) = channel();
    proceed_tx.send(true).unwrap();
    let worker = thread::spawn(move || {
        worker::work(
            sink,
            vec![Plan {
                steps: vec![Step::MoveTo { x: 10, y: 10 }],
                release_origin: None,
            }],
            &Link {
                reports,
                proceed,
                journal: None,
            },
            deadline(30_000),
            &worker_progress,
        );
    });
    ready.recv_timeout(Duration::from_secs(30)).unwrap();
    progress.cancel();
    let error = abandoned(deadline(0), &progress);
    let before_resume = events(&fake);
    resume.send(()).unwrap();
    worker.join().unwrap();
    drop(inbox);

    assert!(before_resume.is_empty());
    assert_eq!(error.disposition, DeliverySemantics::uncertain());
    let details = error.details.unwrap();
    assert_eq!(details["physical_delivery_started"], true);
    assert_eq!(details["delivered_events"], 0);
    assert_eq!(events(&fake), [Recorded::Move(10, 10)]);
}
