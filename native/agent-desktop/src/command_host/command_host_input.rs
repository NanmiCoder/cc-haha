use std::io::{self, BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
use std::time::{Duration, Instant};

pub(super) fn read_frame(
    input: &mut BufReader<impl Read + AsRawFd>,
    limit: usize,
    idle: Duration,
    frame: Duration,
) -> io::Result<Vec<u8>> {
    let mut deadline = Instant::now() + idle;
    let mut bytes = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        if input.buffer().is_empty() {
            wait_ready(input.get_ref().as_raw_fd(), libc::POLLIN, deadline)?;
        }
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let available = input.fill_buf()?;
        if available.is_empty() {
            return Ok(bytes);
        }
        if bytes.is_empty() {
            deadline = Instant::now() + frame;
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1)
            .min(limit.saturating_add(1).saturating_sub(bytes.len()));
        bytes.extend_from_slice(&available[..count]);
        input.consume(count);
        if bytes.last() == Some(&b'\n') || bytes.len() > limit {
            return Ok(bytes);
        }
    }
}

pub(super) fn wait_ready(fd: std::os::fd::RawFd, events: i16, deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::ErrorKind::TimedOut.into());
        }
        let timeout = i32::try_from(remaining.as_millis().saturating_add(1)).unwrap_or(i32::MAX);
        let mut poll = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll, 1, timeout) };
        if result > 0 {
            return if poll.revents & libc::POLLNVAL == 0 {
                Ok(())
            } else {
                Err(io::ErrorKind::InvalidInput.into())
            };
        }
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    #[test]
    fn buffered_requests_are_separate_and_do_not_wait_for_more_input() {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        sender.write_all(b"[]\n[\"version\"]\n").unwrap();
        let mut input = BufReader::new(receiver);
        let budget = Duration::from_secs(60);
        assert_eq!(
            read_frame(&mut input, 100, budget, budget).unwrap(),
            b"[]\n"
        );
        assert_eq!(
            read_frame(&mut input, 100, budget, budget).unwrap(),
            b"[\"version\"]\n"
        );
    }

    #[test]
    fn a_partial_frame_has_a_deadline_even_while_its_sender_stays_connected() {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        sender.write_all(b"[").unwrap();
        let error = read_frame(
            &mut BufReader::new(receiver),
            100,
            Duration::from_secs(60),
            Duration::ZERO,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn expired_idle_budget_does_not_consume_a_queued_request() {
        let (mut sender, receiver) = UnixStream::pair().unwrap();
        sender.write_all(b"[]\n").unwrap();
        let mut input = BufReader::new(receiver);
        assert_eq!(
            read_frame(&mut input, 100, Duration::ZERO, Duration::ZERO)
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        let budget = Duration::from_secs(60);
        assert_eq!(
            read_frame(&mut input, 100, budget, budget).unwrap(),
            b"[]\n"
        );
    }
}
