//! A thread-local call counter, shared by every `#[cfg(test)]` seam that
//! only needs to know how many times something was reached this thread:
//! `record` increments, `take` reads and resets to zero in the same step so
//! consecutive assertions never see a stale count from an earlier one.

use std::cell::Cell;

pub(crate) fn record(counter: &'static std::thread::LocalKey<Cell<usize>>) {
    counter.with(|cell| cell.set(cell.get() + 1));
}

pub(crate) fn take(counter: &'static std::thread::LocalKey<Cell<usize>>) -> usize {
    counter.with(|cell| {
        let value = cell.get();
        cell.set(0);
        value
    })
}
