use std::sync::Arc;

/// The chunks of one INCR transfer on the owner's side. The transfer ends
/// with a zero-length chunk, also when the data is empty or an exact multiple
/// of the chunk size.
#[derive(Debug)]
pub(crate) struct IncrSender {
    data: Arc<[u8]>,
    chunk: usize,
    sent: usize,
    finished: bool,
}

impl IncrSender {
    pub(crate) fn new(data: Arc<[u8]>, chunk: usize) -> Self {
        Self {
            data,
            chunk: chunk.max(1),
            sent: 0,
            finished: false,
        }
    }

    pub(crate) fn next_chunk(&mut self) -> Option<Vec<u8>> {
        if self.finished {
            return None;
        }
        if self.sent >= self.data.len() {
            self.finished = true;
            return Some(Vec::new());
        }
        let end = (self.sent + self.chunk).min(self.data.len());
        let chunk = self.data[self.sent..end].to_vec();
        self.sent = end;
        Some(chunk)
    }
}

#[cfg(test)]
#[path = "incr_tests.rs"]
mod tests;
