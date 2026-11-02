//! Reading a token's user, which the control pipe's peer check depends on.
//!
//! Split from `owner_tests.rs` so that file stays inside the size cap.

use crate::system::runtime::token_sid::{TokenSource, token_user_sid};

/// A token opened by a caller answers the same user as this process's own,
/// which is the question every peer check on the control pipe asks.
///
/// The reader this exercises replaced one that allocated a byte vector and
/// read a `TOKEN_USER` straight out of it. That structure holds a pointer, so
/// the read was unaligned - correct only while the allocator happened to hand
/// back an aligned block, and undefined the moment it did not. There is no way
/// to assert alignment after the fact; what is asserted is that the aligned
/// reader answers, and answers the same principal, through both doors.
///
/// What this cannot see, measured rather than assumed: swapping the handle
/// arm to read the token's OWNER instead of its user leaves this green,
/// because on an account whose owner and user are the same SID the two are
/// indistinguishable here. It discriminates a genuinely different principal -
/// reading the primary group instead fails it - so it guards the door being
/// open and reaching one principal, not the choice of information class.
#[test]
fn a_caller_opened_token_answers_the_same_user_as_this_process() {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    assert!(opened != 0, "this process can open its own token");

    let through_handle = token_user_sid(TokenSource::Handle(token));
    unsafe { CloseHandle(token) };

    let through_handle = through_handle.expect("an opened token names its user");
    let directly = token_user_sid(TokenSource::CurrentProcess)
        .expect("this process's own token names its user");

    assert!(
        through_handle.matches(&directly),
        "the same token read through either door must name one principal, or a pipe peer          check would refuse the very process that opened the pipe"
    );
}
