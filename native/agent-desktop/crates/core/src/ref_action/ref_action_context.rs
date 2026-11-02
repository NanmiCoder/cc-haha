use crate::ref_action::ref_action_wait_context::RefActionWaitContext;

#[derive(Clone, Copy)]
pub(crate) struct RefActionContext<'a> {
    wait: RefActionWaitContext<'a>,
    pub(crate) deadline: crate::Deadline,
}

impl<'a> RefActionContext<'a> {
    pub(crate) fn new(wait: RefActionWaitContext<'a>, deadline: crate::Deadline) -> Self {
        Self { wait, deadline }
    }
}

impl<'a> std::ops::Deref for RefActionContext<'a> {
    type Target = RefActionWaitContext<'a>;

    fn deref(&self) -> &Self::Target {
        &self.wait
    }
}
