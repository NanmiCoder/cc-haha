use x11rb::protocol::xproto::Atom;
use x11rb::rust_connection::RustConnection;

use crate::system::x11::stacking::stacking_decode::StateAtoms;
use crate::system::x11::stacking::type_atoms::TypeAtoms;

const NAMES: [&[u8]; 18] = [
    b"_NET_SUPPORTING_WM_CHECK",
    b"_NET_CLIENT_LIST_STACKING",
    b"_NET_CURRENT_DESKTOP",
    b"_NET_WM_STATE",
    b"_NET_WM_STATE_HIDDEN",
    b"_NET_WM_STATE_ABOVE",
    b"_NET_WM_DESKTOP",
    b"_NET_WM_WINDOW_TYPE",
    b"_NET_WM_WINDOW_TYPE_NORMAL",
    b"_NET_WM_WINDOW_TYPE_DIALOG",
    b"_NET_WM_WINDOW_TYPE_UTILITY",
    b"_NET_WM_WINDOW_TYPE_MENU",
    b"_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
    b"_NET_WM_WINDOW_TYPE_POPUP_MENU",
    b"_NET_WM_WINDOW_TYPE_DOCK",
    b"_NET_WM_WINDOW_TYPE_DESKTOP",
    b"_NET_FRAME_EXTENTS",
    b"_GTK_FRAME_EXTENTS",
];

/// The atoms read off the root window.
pub(in crate::system::x11) struct RootAtoms {
    pub(in crate::system::x11) wm_check: Atom,
    pub(in crate::system::x11) stacking: Atom,
    pub(in crate::system::x11) current_desktop: Atom,
}

/// The atoms read off each client.
pub(in crate::system::x11) struct WindowAtoms {
    pub(in crate::system::x11) state: Atom,
    pub(in crate::system::x11) desktop: Atom,
    pub(in crate::system::x11) kind: Atom,
    pub(in crate::system::x11) frame_extents: Atom,
    pub(in crate::system::x11) gtk_extents: Atom,
    pub(in crate::system::x11) states: StateAtoms,
    pub(in crate::system::x11) types: TypeAtoms,
}

pub(in crate::system::x11) struct Names {
    pub(in crate::system::x11) root: RootAtoms,
    pub(in crate::system::x11) window: WindowAtoms,
}

pub(in crate::system::x11) fn names(connection: &RustConnection) -> Option<Names> {
    let ids: [Atom; 18] = crate::system::x11::control_display::atoms(connection, &NAMES)?
        .try_into()
        .ok()?;
    let [
        wm_check,
        stacking,
        current_desktop,
        state,
        hidden,
        above,
        desktop,
        kind,
        normal,
        dialog,
        utility,
        menu,
        dropdown,
        popup,
        dock,
        desktop_type,
        frame_extents,
        gtk_extents,
    ] = ids;
    Some(Names {
        root: RootAtoms {
            wm_check,
            stacking,
            current_desktop,
        },
        window: WindowAtoms {
            state,
            desktop,
            kind,
            frame_extents,
            gtk_extents,
            states: StateAtoms { hidden, above },
            types: TypeAtoms {
                normal,
                dialog,
                utility,
                menu: [menu, dropdown, popup],
                dock,
                desktop: desktop_type,
            },
        },
    })
}
