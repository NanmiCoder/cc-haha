use super::*;

fn drain(mut sender: IncrSender) -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    while let Some(chunk) = sender.next_chunk() {
        chunks.push(chunk);
    }
    chunks
}

#[test]
fn an_exact_multiple_ends_with_a_zero_chunk() {
    let chunks = drain(IncrSender::new(vec![1; 8].into(), 4));
    let sizes: Vec<usize> = chunks.iter().map(Vec::len).collect();
    assert_eq!(sizes, [4, 4, 0]);
}

#[test]
fn an_empty_payload_emits_only_the_zero_chunk() {
    assert_eq!(
        drain(IncrSender::new(Vec::new().into(), 4)),
        [Vec::<u8>::new()]
    );
}

#[test]
fn the_sender_stays_finished() {
    let mut sender = IncrSender::new(vec![1].into(), 4);
    assert!(sender.next_chunk().is_some());
    assert_eq!(sender.next_chunk(), Some(Vec::new()));
    assert_eq!(sender.next_chunk(), None);
    assert_eq!(sender.next_chunk(), None);
}
