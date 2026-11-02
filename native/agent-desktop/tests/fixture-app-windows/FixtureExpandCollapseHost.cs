using System;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Backs both <c>menu-disclosure</c> (<c>ControlType.Button</c>) and
    /// <c>outline-parent</c> (<c>ControlType.TreeItem</c>): a control
    /// answering <c>IsExpandCollapsePatternAvailable</c> and
    /// <see cref="IExpandCollapseProvider"/> itself, parameterized on which
    /// <c>ControlType</c> to report so the same expand/collapse state
    /// machine and thread-safety discipline back both targets rather than
    /// being duplicated per role.
    ///
    /// <see cref="ToolStripSplitButton"/> was tried first for
    /// <c>menu-disclosure</c> as the zero-custom-code shape - it did not
    /// survive the read-back-while-building loop: <c>ToolStripItem.Name</c>
    /// does not surface as UIA <c>AutomationId</c> on this stock provider
    /// (measured empirically; confirmed by <c>--native-id menu-disclosure</c>
    /// returning zero matches against a real running fixture), unlike
    /// <c>Control.Name</c>, which A24-2 measured and which this class's own
    /// <c>owner</c> control still carries. This host is what actually ships.
    /// </summary>
    internal sealed class ExpandCollapseButtonHost : UiaProviderHost
    {
        private readonly object gate = new object();
        private readonly Control owner;
        private readonly string automationId;
        private readonly int controlTypeId;
        private ExpandCollapseState state;

        internal ExpandCollapseButtonHost(Control owner, string automationId)
            : this(owner, automationId, ControlType.Button.Id)
        {
        }

        internal ExpandCollapseButtonHost(Control owner, string automationId, int controlTypeId)
        {
            this.owner = owner;
            this.automationId = automationId;
            this.controlTypeId = controlTypeId;
            this.state = ExpandCollapseState.Collapsed;
        }

        internal event EventHandler StateChanged;

        internal ExpandCollapseState CurrentState
        {
            get { lock (this.gate) { return this.state; } }
        }

        internal void ExpandNow()
        {
            this.SetState(ExpandCollapseState.Expanded);
        }

        internal void CollapseNow()
        {
            this.SetState(ExpandCollapseState.Collapsed);
        }

        private void SetState(ExpandCollapseState next)
        {
            lock (this.gate)
            {
                this.state = next;
            }
            if (this.owner.InvokeRequired)
            {
                this.owner.BeginInvoke((MethodInvoker)delegate { this.RaiseStateChanged(); });
            }
            else
            {
                this.RaiseStateChanged();
            }
        }

        private void RaiseStateChanged()
        {
            if (this.StateChanged != null)
            {
                this.StateChanged(this, EventArgs.Empty);
            }
        }

        protected override IRawElementProviderSimple CreateProvider(IntPtr handle)
        {
            return new Provider(this, handle);
        }

        private sealed class Provider : IRawElementProviderSimple, IExpandCollapseProvider
        {
            private readonly ExpandCollapseButtonHost host;
            private readonly IntPtr handle;

            internal Provider(ExpandCollapseButtonHost host, IntPtr handle)
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
                if (patternId == ExpandCollapsePatternIdentifiers.Pattern.Id)
                {
                    return this;
                }
                return null;
            }

            public object GetPropertyValue(int propertyId)
            {
                if (propertyId == AutomationElementIdentifiers.IsExpandCollapsePatternAvailableProperty.Id)
                {
                    return true;
                }
                if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id)
                {
                    return this.host.controlTypeId;
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

            public void Expand()
            {
                this.host.ExpandNow();
            }

            public void Collapse()
            {
                this.host.CollapseNow();
            }

            public ExpandCollapseState ExpandCollapseState
            {
                get { return this.host.CurrentState; }
            }
        }
    }
}
