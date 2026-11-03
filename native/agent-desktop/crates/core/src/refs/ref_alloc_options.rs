#[derive(Clone, Copy)]
pub(crate) struct RefAllocOptions {
    pub(crate) include_bounds: bool,
    pub(crate) interactive_only: bool,
    pub(crate) compact: bool,
}
