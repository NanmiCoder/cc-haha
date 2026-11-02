use std::future::Future;

use futures_util::stream::{self, StreamExt};

/// Runs `futures` with at most `limit` in flight and returns their outputs in
/// input order.
pub(in crate::tree) async fn collect_bounded<F: Future>(
    limit: usize,
    futures: impl IntoIterator<Item = F>,
) -> Vec<F::Output> {
    stream::iter(futures).buffered(limit).collect().await
}

#[cfg(test)]
#[path = "bounded_tests.rs"]
mod tests;
