using System;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Backs <c>switch-button</c>: a plain WinForms <see cref="Button"/> has
    /// no toggling shape at all, so <c>roles.rs</c>'s <c>button_role</c> never
    /// takes the <c>ToggleAvailable</c> arm against one. This host answers
    /// <c>IsTogglePatternAvailableProperty</c> and <see cref="IToggleProvider"/>
    /// itself and leaves every other
    /// property (bounds, enabled, offscreen, name) to the host provider via
    /// <see cref="IRawElementProviderSimple.HostRawElementProvider"/>, so the
    /// control stays a fully functional, boundable, clickable Button that
    /// additionally advertises Toggle.
    ///
    /// <see cref="Toggle"/> can be called by UI Automation on a thread other
    /// than the UI thread (it is a direct COM call from the client process),
    /// so the state flip itself happens synchronously under a lock - the
    /// product reads the new state back immediately after issuing the
    /// command, and a deferred flip would race that read - while the visible
    /// button text update is marshalled onto the UI thread separately.
    /// </summary>
    internal sealed class ToggleButtonHost : UiaProviderHost
    {
        private readonly object gate = new object();
        private readonly Control owner;
        private readonly string automationId;
        private ToggleState state;

        internal ToggleButtonHost(Control owner, string automationId)
        {
            this.owner = owner;
            this.automationId = automationId;
            this.state = ToggleState.Off;
        }

        internal event EventHandler Toggled;

        internal ToggleState CurrentState
        {
            get { lock (this.gate) { return this.state; } }
        }

        internal void ToggleNow()
        {
            ToggleState next;
            lock (this.gate)
            {
                this.state = (this.state == ToggleState.On) ? ToggleState.Off : ToggleState.On;
                next = this.state;
            }
            if (this.owner.InvokeRequired)
            {
                this.owner.BeginInvoke((MethodInvoker)delegate { this.RaiseToggled(); });
            }
            else
            {
                this.RaiseToggled();
            }
        }

        private void RaiseToggled()
        {
            if (this.Toggled != null)
            {
                this.Toggled(this, EventArgs.Empty);
            }
        }

        protected override IRawElementProviderSimple CreateProvider(IntPtr handle)
        {
            return new Provider(this, handle);
        }

        private sealed class Provider : IRawElementProviderSimple, IToggleProvider
        {
            private readonly ToggleButtonHost host;
            private readonly IntPtr handle;

            internal Provider(ToggleButtonHost host, IntPtr handle)
            {
                this.host = host;
                this.handle = handle;
            }

            public ProviderOptions ProviderOptions
            {
                get { return ProviderOptions.ServerSideProvider; }
            }

            public object GetPatternProvider(int patternId)
            {
                if (patternId == TogglePatternIdentifiers.Pattern.Id)
                {
                    return this;
                }
                return null;
            }

            public object GetPropertyValue(int propertyId)
            {
                if (propertyId == AutomationElementIdentifiers.IsTogglePatternAvailableProperty.Id)
                {
                    return true;
                }
                if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id)
                {
                    return ControlType.Button.Id;
                }
                if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id)
                {
                    return this.host.automationId;
                }
                return null;
            }

            public IRawElementProviderSimple HostRawElementProvider
            {
                get { return AutomationInteropProvider.HostProviderFromHandle(this.handle); }
            }

            public void Toggle()
            {
                this.host.ToggleNow();
            }

            public ToggleState ToggleState
            {
                get { return this.host.CurrentState; }
            }
        }
    }
}
