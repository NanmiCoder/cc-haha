#[derive(Clone, Copy)]
pub(crate) struct RefAllocScope<'a> {
    pub(crate) root_ref_id: Option<&'a str>,
    pub(crate) path_prefix: &'a [usize],
}
