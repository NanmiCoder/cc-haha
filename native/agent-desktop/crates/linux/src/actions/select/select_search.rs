use agent_desktop_core::AdapterError;

pub(crate) const NODE_LIMIT: usize = 2048;
pub(crate) const DEPTH_LIMIT: usize = 8;

pub(crate) struct Inspected {
    pub(crate) name: Option<String>,
    pub(crate) selection: bool,
    pub(crate) selectable: bool,
}

pub(crate) trait ItemReader {
    type Node: Clone;

    fn inspect(&mut self, node: &Self::Node) -> Result<Inspected, AdapterError>;

    fn children(&mut self, node: &Self::Node) -> Result<Vec<Self::Node>, AdapterError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Container<N> {
    pub(crate) node: N,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hit<N> {
    pub(crate) item: N,
    pub(crate) container: Option<Container<N>>,
    pub(crate) row: Option<N>,
    pub(crate) own: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Search<N> {
    Found(Hit<N>),
    Ambiguous,
    NotFound { selectable: bool },
    Incomplete,
}

pub(crate) fn name_matches(name: &str, wanted: &str) -> bool {
    name.trim().to_lowercase() == wanted.trim().to_lowercase()
}

struct Pending<N> {
    node: N,
    depth: usize,
    container: Option<Container<N>>,
    row: Option<N>,
}

pub(crate) fn search<R: ItemReader>(
    reader: &mut R,
    root: &R::Node,
    wanted: &str,
) -> Result<Search<R::Node>, AdapterError> {
    let mut stack = vec![Pending {
        node: root.clone(),
        depth: 0,
        container: None,
        row: None,
    }];
    let mut seen = 0;
    let mut selectable = false;
    let mut incomplete = false;
    let mut found: Option<Hit<R::Node>> = None;
    while let Some(pending) = stack.pop() {
        if seen >= NODE_LIMIT {
            incomplete = true;
            break;
        }
        seen += 1;
        let inspected = match reader.inspect(&pending.node) {
            Ok(inspected) => inspected,
            Err(error) if pending.depth == 0 => return Err(error),
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        selectable |= inspected.selectable;
        let matched = inspected
            .name
            .as_deref()
            .is_some_and(|name| name_matches(name, wanted));
        if matched {
            if found.is_some() {
                return Ok(Search::Ambiguous);
            }
            found = Some(Hit {
                item: pending.node,
                container: pending.container,
                row: pending.row,
                own: pending.depth == 0,
            });
            continue;
        }
        let children = match reader.children(&pending.node) {
            Ok(children) => children,
            Err(error) if pending.depth == 0 => return Err(error),
            Err(_) => {
                incomplete = true;
                continue;
            }
        };
        if pending.depth >= DEPTH_LIMIT {
            incomplete |= !children.is_empty();
            continue;
        }
        for child in children.into_iter().rev() {
            let container = if inspected.selection {
                Some(Container {
                    node: pending.node.clone(),
                })
            } else {
                pending.container.clone()
            };
            let row = if inspected.selection {
                Some(child.clone())
            } else {
                pending.row.clone()
            };
            stack.push(Pending {
                node: child,
                depth: pending.depth + 1,
                container,
                row,
            });
        }
    }
    if incomplete {
        return Ok(Search::Incomplete);
    }
    Ok(match found {
        _ if incomplete => Search::Incomplete,
        Some(hit) => Search::Found(hit),
        None => Search::NotFound { selectable },
    })
}

#[cfg(test)]
#[path = "select_search_tests.rs"]
mod tests;
