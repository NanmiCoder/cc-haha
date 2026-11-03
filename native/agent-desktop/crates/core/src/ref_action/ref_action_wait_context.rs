use crate::{CommandContext, PlatformAdapter, RefEntry};

#[derive(Clone, Copy)]
pub(crate) struct RefActionWaitContext<'a> {
    pub(crate) adapter: &'a dyn PlatformAdapter,
    pub(crate) entry: &'a RefEntry,
    pub(crate) ref_id: &'a str,
    pub(crate) context: &'a CommandContext,
}
