use std::sync::atomic::{AtomicU64, Ordering};

/// A distinct, valid nonce per call, shaped like the 32 lowercase hex digits
/// a real owner record uses.
pub(crate) fn test_nonce() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let counter = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("{:016x}{:016x}", std::process::id(), counter)
}
