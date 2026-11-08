use std::cell::Cell;

use futures_util::future::poll_fn;
use std::task::Poll;

use super::collect_bounded;

async fn hold(running: &Cell<usize>, peak: &Cell<usize>, value: usize) -> usize {
    running.set(running.get() + 1);
    peak.set(peak.get().max(running.get()));
    let mut polls = 0;
    poll_fn(|context| {
        polls += 1;
        if polls < 3 {
            context.waker().wake_by_ref();
            Poll::Pending
        } else {
            Poll::Ready(())
        }
    })
    .await;
    running.set(running.get() - 1);
    value
}

#[test]
fn a_large_batch_never_exceeds_the_limit_and_keeps_its_order() {
    let running = Cell::new(0);
    let peak = Cell::new(0);
    let out = zbus::block_on(collect_bounded(
        4,
        (0..200).map(|value| hold(&running, &peak, value)),
    ));
    assert_eq!(out, (0..200).collect::<Vec<_>>());
    assert_eq!(peak.get(), 4);
}
