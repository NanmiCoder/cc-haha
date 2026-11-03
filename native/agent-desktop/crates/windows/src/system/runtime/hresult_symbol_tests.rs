use super::{
    CO_E_NOTINITIALIZED, DXGI_ERROR_DEVICE_REMOVED, E_ACCESSDENIED, E_FAIL, E_INVALIDARG,
    E_NOINTERFACE, E_POINTER, E_UNEXPECTED, RPC_E_DISCONNECTED, RPC_E_SERVERFAULT,
    RPC_S_CALL_FAILED, RPC_S_SERVER_UNAVAILABLE, UIA_E_ELEMENTNOTAVAILABLE,
    UIA_E_ELEMENTNOTENABLED, UIA_E_INVALIDOPERATION, UIA_E_NOCLICKABLEPOINT, UIA_E_NOTSUPPORTED,
    UIA_E_PROXYASSEMBLYNOTLOADED, UIA_E_TIMEOUT, WINCODEC_ERR_BADIMAGE,
    WINCODEC_ERR_COMPONENTNOTFOUND, WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT, com_hresult_detail,
    com_hresult_symbol,
};

const UNNAMED_HRESULT: i32 = 0x8000_4004_u32 as i32;

/// Every HRESULT the crate names carries its symbol and meaning into
/// `platform_detail`, stated as literals here.
///
/// Without this, an arm could be dropped from `com_hresult_symbol` and every
/// test would stay green while the code silently degraded to a bare
/// hexadecimal value in the one field an operator reads to find out what
/// happened.
#[test]
fn every_named_hresult_renders_its_symbol_and_meaning() {
    let named: [(i32, &str, &str); 22] = [
        (E_ACCESSDENIED, "E_ACCESSDENIED", "Access is denied"),
        (
            E_NOINTERFACE,
            "E_NOINTERFACE",
            "No such interface supported",
        ),
        (E_POINTER, "E_POINTER", "Invalid pointer"),
        (E_FAIL, "E_FAIL", "Unspecified failure"),
        (E_UNEXPECTED, "E_UNEXPECTED", "Catastrophic failure"),
        (
            E_INVALIDARG,
            "E_INVALIDARG",
            "One or more arguments are invalid",
        ),
        (
            CO_E_NOTINITIALIZED,
            "CO_E_NOTINITIALIZED",
            "COM has not been initialized",
        ),
        (
            RPC_E_SERVERFAULT,
            "RPC_E_SERVERFAULT",
            "The server raised an exception",
        ),
        (
            RPC_E_DISCONNECTED,
            "RPC_E_DISCONNECTED",
            "The object invoked has disconnected",
        ),
        (
            RPC_S_SERVER_UNAVAILABLE,
            "RPC_S_SERVER_UNAVAILABLE",
            "The RPC server is unavailable",
        ),
        (
            RPC_S_CALL_FAILED,
            "RPC_S_CALL_FAILED",
            "The remote procedure call failed",
        ),
        (
            UIA_E_ELEMENTNOTENABLED,
            "UIA_E_ELEMENTNOTENABLED",
            "The element is not enabled",
        ),
        (
            UIA_E_ELEMENTNOTAVAILABLE,
            "UIA_E_ELEMENTNOTAVAILABLE",
            "The element is not available",
        ),
        (
            UIA_E_NOCLICKABLEPOINT,
            "UIA_E_NOCLICKABLEPOINT",
            "The element has no clickable point",
        ),
        (
            UIA_E_PROXYASSEMBLYNOTLOADED,
            "UIA_E_PROXYASSEMBLYNOTLOADED",
            "The proxy assembly could not be loaded",
        ),
        (
            UIA_E_NOTSUPPORTED,
            "UIA_E_NOTSUPPORTED",
            "The requested operation is unsupported",
        ),
        (UIA_E_TIMEOUT, "UIA_E_TIMEOUT", "The operation timed out"),
        (
            UIA_E_INVALIDOPERATION,
            "UIA_E_INVALIDOPERATION",
            "The operation is not valid",
        ),
        (
            WINCODEC_ERR_COMPONENTNOTFOUND,
            "WINCODEC_ERR_COMPONENTNOTFOUND",
            "The imaging component was not found",
        ),
        (
            WINCODEC_ERR_BADIMAGE,
            "WINCODEC_ERR_BADIMAGE",
            "The image is unrecognized",
        ),
        (
            WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT,
            "WINCODEC_ERR_UNSUPPORTEDPIXELFORMAT",
            "The bitmap pixel format is unsupported",
        ),
        (
            DXGI_ERROR_DEVICE_REMOVED,
            "DXGI_ERROR_DEVICE_REMOVED",
            "The GPU device has been removed",
        ),
    ];

    for (hresult, symbol, meaning) in named {
        assert_eq!(
            com_hresult_symbol(hresult),
            Some((symbol, meaning)),
            "0x{hresult:08X} symbol and meaning"
        );
        let detail = com_hresult_detail(hresult);
        assert!(
            detail.contains(symbol) && detail.contains(meaning),
            "0x{hresult:08X} detail must carry both, got {detail}"
        );
    }

    assert_eq!(
        com_hresult_detail(0x8004_0201_u32 as i32),
        "COM HRESULT 0x80040201 (UIA_E_ELEMENTNOTAVAILABLE: The element is not available)"
    );
    assert_eq!(
        com_hresult_detail(0x8004_01F0_u32 as i32),
        "COM HRESULT 0x800401F0 (CO_E_NOTINITIALIZED: COM has not been initialized)"
    );
}

/// A code no one named renders as a bare value rather than being guessed at,
/// which is the control that makes the assertions above mean something: were
/// every code to answer `Some`, the pins would pass without discriminating.
#[test]
fn an_unnamed_hresult_renders_as_a_bare_value() {
    assert_eq!(com_hresult_symbol(UNNAMED_HRESULT), None);
    let detail = com_hresult_detail(UNNAMED_HRESULT);
    assert_eq!(detail, "COM HRESULT 0x80004004");
}
