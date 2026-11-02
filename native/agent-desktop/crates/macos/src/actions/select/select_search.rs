/// What `find_named_descendant` is looking for. An open-menu search takes the
/// first matching item, while a collection search must see every candidate to
/// prove the match is unique — so only a collection search still reads children
/// at the depth cap, where they decide whether the search can fail closed.
#[derive(Clone, Copy)]
pub(crate) enum SelectSearch {
    MenuItem,
    Collection,
}
