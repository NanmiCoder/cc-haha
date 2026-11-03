use std::time::{Duration, Instant};

pub(crate) fn read<T>(
    deadline: Instant,
    mut observe: impl FnMut() -> Result<T, i32>,
) -> Result<T, i32> {
    for attempt in 0..3 {
        if Instant::now() >= deadline {
            return Err(accessibility_sys::kAXErrorCannotComplete);
        }
        let result = observe();
        if Instant::now() >= deadline {
            return Err(accessibility_sys::kAXErrorCannotComplete);
        }
        if !matches!(result, Err(accessibility_sys::kAXErrorCannotComplete)) || attempt == 2 {
            return result;
        }
        std::thread::sleep(
            deadline
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(1)),
        );
    }
    Err(accessibility_sys::kAXErrorCannotComplete)
}

#[cfg(test)]
mod tests {
    use super::*;
    use accessibility_sys::{
        kAXErrorAPIDisabled, kAXErrorCannotComplete, kAXErrorFailure, kAXErrorInvalidUIElement,
    };

    #[test]
    fn transient_read_returns_the_fresh_value() {
        let mut reads = 0;
        let value = read(Instant::now() + Duration::from_secs(60), || {
            reads += 1;
            if reads == 1 {
                Err(kAXErrorCannotComplete)
            } else {
                Ok("textfield")
            }
        });
        assert_eq!(value, Ok("textfield"));
        assert_eq!(reads, 2);
    }

    #[test]
    fn only_transport_failures_retry_and_attempts_are_bounded() {
        for (error, expected) in [
            (kAXErrorCannotComplete, 3),
            (kAXErrorFailure, 1),
            (kAXErrorInvalidUIElement, 1),
            (kAXErrorAPIDisabled, 1),
        ] {
            let mut calls = 0;
            let result = read::<()>(Instant::now() + Duration::from_secs(60), || {
                calls += 1;
                Err(error)
            });
            assert_eq!(result, Err(error));
            assert_eq!(calls, expected);
        }
        assert_eq!(
            read::<()>(Instant::now(), || panic!("expired read")),
            Err(kAXErrorCannotComplete)
        );
    }
}
