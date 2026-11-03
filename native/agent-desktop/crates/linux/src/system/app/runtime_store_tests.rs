use std::sync::Barrier;

use super::write_private_atomically;

#[test]
fn concurrent_writes_publish_complete_records() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "agent-desktop-runtime-writes-{}-{stamp}",
        std::process::id()
    ));
    let path = dir.join("record");
    let payloads: Vec<Vec<u8>> = (1..=8).map(|id| vec![id; usize::from(id) * 4096]).collect();
    let barrier = Barrier::new(payloads.len());
    std::thread::scope(|scope| {
        for payload in &payloads {
            let (dir, path, payloads, barrier) = (&dir, &path, &payloads, &barrier);
            scope.spawn(move || {
                barrier.wait();
                for _ in 0..16 {
                    write_private_atomically(dir, path, payload).expect("publish record");
                    let observed = std::fs::read(path).expect("read published record");
                    assert!(
                        payloads.contains(&observed),
                        "a record must be one complete write"
                    );
                }
            });
        }
    });
    std::fs::remove_dir_all(dir).expect("remove test records");
}
