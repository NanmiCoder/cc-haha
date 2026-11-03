#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct StabilityExpectation {
    pub(crate) bounds_hash: Option<u64>,
    pub(crate) bounds: Option<crate::Rect>,
    pub(crate) strict: bool,
    pub(crate) samples: u32,
    pub(crate) span_ms: u64,
}

impl StabilityExpectation {
    pub(crate) fn permissive(bounds_hash: Option<u64>) -> Self {
        Self {
            bounds_hash,
            bounds: None,
            strict: false,
            samples: 1,
            span_ms: 0,
        }
    }

    pub(crate) fn strict(bounds: Option<crate::Rect>, samples: u32, span_ms: u64) -> Self {
        Self {
            bounds_hash: bounds.and_then(|bounds| bounds.bounds_hash()),
            bounds,
            strict: true,
            samples,
            span_ms,
        }
    }

    pub(crate) fn strict_hash(bounds_hash: Option<u64>) -> Self {
        Self {
            bounds_hash,
            bounds: None,
            strict: true,
            samples: 1,
            span_ms: 0,
        }
    }
}
