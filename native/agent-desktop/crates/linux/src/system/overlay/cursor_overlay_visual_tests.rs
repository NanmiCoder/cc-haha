use super::*;

#[test]
fn a_format_count_larger_than_the_reply_is_reported_as_truncated() {
    let mut reply = vec![0; 32];
    reply[8..12].copy_from_slice(&2u32.to_ne_bytes());
    let error = visual_in(&reply, 0).expect_err("two records require bytes after the header");
    assert_eq!(
        error.platform_detail.as_deref(),
        Some("Truncated RENDER picture formats")
    );
}

#[test]
fn an_xrgb_visual_is_refused_and_argb_is_scoped_to_its_screen() {
    let mut reply = vec![0; 32];
    reply[8..12].copy_from_slice(&2u32.to_ne_bytes());
    reply[12..16].copy_from_slice(&2u32.to_ne_bytes());
    for (id, alpha) in [(10u32, 0u16), (11, 255)] {
        reply.extend(id.to_ne_bytes());
        reply.extend([1, 32, 0, 0]);
        for value in [16u16, 255, 8, 255, 0, 255, 24, alpha] {
            reply.extend(value.to_ne_bytes());
        }
        reply.extend(0u32.to_ne_bytes());
    }
    for (visual, format) in [(100u32, 10u32), (101, 11)] {
        reply.extend(1u32.to_ne_bytes());
        reply.extend(format.to_ne_bytes());
        reply.extend([32, 0]);
        reply.extend(1u16.to_ne_bytes());
        reply.extend(0u32.to_ne_bytes());
        reply.extend(visual.to_ne_bytes());
        reply.extend(format.to_ne_bytes());
    }
    assert_eq!(
        visual_in(&reply, 0).unwrap_err().code,
        agent_desktop_core::ErrorCode::PlatformNotSupported
    );
    assert_eq!(visual_in(&reply, 1).unwrap(), 101);
    assert!(visual_in(&reply[..reply.len() - 1], 1).is_err());
}
