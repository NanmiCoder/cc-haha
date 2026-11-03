use crate::{
    refs::ref_alloc_options::RefAllocOptions, refs::ref_alloc_scope::RefAllocScope,
    refs::ref_alloc_source::RefAllocSource,
};

#[derive(Clone, Copy)]
pub(crate) struct RefAllocConfig<'a> {
    pub(crate) options: RefAllocOptions,
    pub(crate) source: RefAllocSource<'a>,
    pub(crate) scope: RefAllocScope<'a>,
}
