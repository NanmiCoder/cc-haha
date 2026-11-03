use super::*;

#[test]
fn strip_partition_and_refusals() {
    let original = GrabRect {
        x: 30,
        y: 100,
        width: 10,
        height: 10,
    };
    let row_bytes = 40;
    let limit = 120;
    let strips = original.strips(row_bytes, limit).unwrap();
    assert_eq!(
        strips
            .iter()
            .map(|strip| u32::from(strip.height))
            .sum::<u32>(),
        10
    );
    assert_eq!(strips[0].y, original.y);
    assert!(strips.iter().all(|strip| {
        strip.x == original.x
            && strip.width == original.width
            && usize::from(strip.height) * row_bytes <= limit
    }));
    for pair in strips.windows(2) {
        assert_eq!(pair[0].y + pair[0].height as i16, pair[1].y);
    }
    let last = strips.last().unwrap();
    assert_eq!(
        last.y + last.height as i16,
        original.y + original.height as i16
    );

    assert_eq!(original.strips(row_bytes, 400).unwrap(), vec![original]);
    assert_eq!(
        original.strips(row_bytes, row_bytes - 1),
        Err(GrabError::Resource)
    );
    assert!(original.strips(row_bytes, row_bytes).is_ok());
    assert_eq!(
        GrabRect {
            y: i16::MAX,
            ..original
        }
        .strips(row_bytes, limit),
        Err(GrabError::Resource)
    );
}
