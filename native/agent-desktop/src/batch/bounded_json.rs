use std::io::{Error, ErrorKind, Write};

use serde_json::Value;

pub(super) fn serialized_size(value: &Value) -> usize {
    let mut writer = CountingWriter::new(usize::MAX);
    let _ = serde_json::to_writer(&mut writer, value);
    writer.written
}

pub(super) fn serialized_fits(value: &Value, limit: usize) -> bool {
    serde_json::to_writer(CountingWriter::new(limit), value).is_ok()
}

struct CountingWriter {
    limit: usize,
    written: usize,
}

impl CountingWriter {
    fn new(limit: usize) -> Self {
        Self { limit, written: 0 }
    }
}

impl Write for CountingWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.written) {
            return Err(Error::new(ErrorKind::FileTooLarge, "JSON output limit"));
        }
        self.written += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
