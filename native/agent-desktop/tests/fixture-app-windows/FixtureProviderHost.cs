using System;
using System.Windows.Automation.Provider;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Subclasses an already-created control's window and answers the UIA
    /// root-object query (<c>WM_GETOBJECT</c>, <c>lParam == UiaRootObjectId</c>)
    /// with a custom provider, delegating every other message - including
    /// every other accessibility query - back to the control's own window
    /// procedure via <see cref="NativeWindow.DefWndProc"/>. This is the exact
    /// mechanism <c>probes/windows/24-fixture-e2e/06-cell-role-provider.ps1</c>
    /// proved compiles and reads back on this toolchain (A24-9), generalized
    /// so more than one card can reuse it instead of each hand-rolling its
    /// own <see cref="NativeWindow"/> subclass.
    ///
    /// Hooked from <see cref="Control.HandleCreated"/> rather than once at
    /// construction: WinForms recreates a control's native handle on some
    /// property changes, and a hook taken only at construction would go
    /// silently stale the first time that happens.
    /// </summary>
    internal abstract class UiaProviderHost : NativeWindow
    {
        private const int WmGetObject = 0x003D;
        private static readonly IntPtr UiaRootObjectId = new IntPtr(-25);

        private IRawElementProviderSimple cachedProvider;

        internal void Hook(Control control)
        {
            control.HandleCreated += delegate { this.AttachTo(control.Handle); };
            control.HandleDestroyed += delegate { this.DetachIfOwned(); };
            if (control.IsHandleCreated)
            {
                this.AttachTo(control.Handle);
            }
        }

        private void AttachTo(IntPtr handle)
        {
            this.DetachIfOwned();
            this.AssignHandle(handle);
            this.cachedProvider = null;
        }

        private void DetachIfOwned()
        {
            if (this.Handle != IntPtr.Zero)
            {
                this.ReleaseHandle();
            }
        }

        protected abstract IRawElementProviderSimple CreateProvider(IntPtr handle);

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmGetObject && m.LParam == UiaRootObjectId)
            {
                if (this.cachedProvider == null)
                {
                    this.cachedProvider = this.CreateProvider(m.HWnd);
                }
                m.Result = AutomationInteropProvider.ReturnRawElementProvider(
                    m.HWnd, m.WParam, m.LParam, this.cachedProvider);
                return;
            }
            base.WndProc(ref m);
        }
    }
}
