use super::*;

fn rect(x: f64) -> Rect {
    Rect {
        x,
        y: 0.0,
        width: 100.0,
        height: 20.0,
    }
}

#[test]
fn thirty_hertz_change_cannot_pass_on_phase_aligned_equal_samples() {
    let mut sampler = StabilitySampler::new();
    assert!(!sampler.observe(Some(rect(0.0)), Duration::ZERO));
    assert!(!sampler.observe(Some(rect(0.0)), Duration::from_millis(17)));
    assert!(!sampler.observe(Some(rect(10.0)), Duration::from_millis(34)));
    assert!(!sampler.observe(Some(rect(10.0)), Duration::from_millis(51)));
    assert!(sampler.observe(Some(rect(10.0)), Duration::from_millis(68)));
}

#[test]
fn sixty_hertz_motion_resets_the_stability_window() {
    let mut sampler = StabilitySampler::new();
    for (index, elapsed) in [0, 17, 34, 51].into_iter().enumerate() {
        assert!(!sampler.observe(Some(rect(index as f64)), Duration::from_millis(elapsed)));
    }
    assert!(!sampler.observe(Some(rect(3.0)), Duration::from_millis(68)));
    assert!(sampler.observe(Some(rect(3.0)), Duration::from_millis(85)));
}

#[test]
fn subpixel_jitter_within_tolerance_is_stable() {
    let mut sampler = StabilitySampler::new();
    assert!(!sampler.observe(Some(rect(10.0)), Duration::ZERO));
    assert!(!sampler.observe(Some(rect(10.2)), Duration::from_millis(17)));
    assert!(sampler.observe(Some(rect(9.8)), Duration::from_millis(34)));
}
