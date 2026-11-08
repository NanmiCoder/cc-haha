/// What a write can change on a node, each part `None` when it was not read.
/// Focus, showing and any armed state never count: they move without the
/// write having done anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Observation {
    pub(in crate::tree) checked: Option<bool>,
    pub(in crate::tree) expanded: Option<bool>,
    pub(in crate::tree) selected: Option<bool>,
    pub(in crate::tree) pressed: Option<bool>,
    pub(in crate::tree) value: Option<Option<String>>,
    pub(in crate::tree) name: Option<Option<String>>,
    pub(in crate::tree) child_count: Option<usize>,
}

fn differs<T: PartialEq>(now: &Option<T>, before: &Option<T>) -> Option<bool> {
    Some(now.as_ref()? != before.as_ref()?)
}

impl Observation {
    /// Whether any part both readings share differs: `Some(true)` as soon as
    /// one does, `Some(false)` only when every part was read both times and
    /// none differs, `None` when an unread part leaves it undecided.
    pub(crate) fn changed_since(&self, before: &Observation) -> Option<bool> {
        let verdicts = [
            differs(&self.checked, &before.checked),
            differs(&self.expanded, &before.expanded),
            differs(&self.selected, &before.selected),
            differs(&self.pressed, &before.pressed),
            differs(&self.value, &before.value),
            differs(&self.name, &before.name),
            differs(&self.child_count, &before.child_count),
        ];
        if verdicts.contains(&Some(true)) {
            Some(true)
        } else if verdicts.contains(&None) {
            None
        } else {
            Some(false)
        }
    }
}
