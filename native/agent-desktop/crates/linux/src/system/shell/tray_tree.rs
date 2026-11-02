use agent_desktop_core::{
    AdapterError, IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence,
    ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree, SnapshotSurface, WindowInfo,
};

use crate::system::tray::view::TrayView;

pub(crate) fn logical_tree(
    view: &TrayView,
    window: &WindowInfo,
    surface: SnapshotSurface,
) -> Result<ObservedTree, AdapterError> {
    let evidence = LocatorEvidence {
        role: LocatorField::Known("group".to_owned()),
        name: LocatorField::Known("System tray".to_owned()),
        description: LocatorField::Absent,
        value: LocatorField::Absent,
        identifiers: IdentifierEvidence::absent(),
        states: LocatorField::Known(Vec::new()),
        ref_evidence: LocatorRefEvidence {
            bounds: LocatorField::Absent,
            window_bounds: LocatorField::Absent,
            available_actions: LocatorField::Known(Vec::new()),
            descriptors: Default::default(),
        },
    };
    ObservedTree::from_roots(
        vec![ObservedSubtree::new(evidence, view.subtrees(), true, None)],
        ObservationSource::from_root(&ObservationRoot::Window(window), surface),
        Default::default(),
        true,
    )
}
