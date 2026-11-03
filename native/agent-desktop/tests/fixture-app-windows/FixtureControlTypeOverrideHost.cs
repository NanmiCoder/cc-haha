using System;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Overrides <c>ControlTypeProperty</c> and <c>AutomationIdProperty</c>,
    /// leaving every other query - bounds, enabled, offscreen, name - to the
    /// host control's own default provider. Used wherever a target needs a
    /// <c>ControlType</c> no stock control produces but no pattern-gated
    /// role refinement is involved (unlike <see cref="ToggleButtonHost"/> /
    /// <see cref="ExpandCollapseButtonHost"/>): <c>menu-fire-item</c>
    /// (<see cref="ControlType.MenuItem"/>, since <c>ToolStripItem.Name</c>
    /// does not surface as <c>AutomationId</c> the way
    /// <see cref="Control.Name"/> does - the same finding that moved
    /// <c>menu-disclosure</c> off <see cref="ToolStripSplitButton"/>) and the
    /// outline's own container plus its leaf items
    /// (<see cref="ControlType.Tree"/> / <see cref="ControlType.TreeItem"/>,
    /// since <c>TreeNode.Name</c> does not surface as <c>AutomationId</c>
    /// either - measured the same way, <c>--native-id outline-parent</c>
    /// returned zero matches against the stock <see cref="TreeView"/>
    /// shape this replaced).
    ///
    /// A registered custom raw provider does **not** transparently inherit
    /// the host's own <c>InvokePattern</c> availability the way bounds or
    /// enabled-state merge through <see cref="IRawElementProviderSimple.HostRawElementProvider"/>
    /// - measured live against <c>menu-fire-item</c>: with no explicit
    /// <see cref="IInvokeProvider"/>, <c>InvokePattern.Invoke</c> came back
    /// <c>skipped</c> and the click chain's <c>LegacyIAccessible.DoDefaultAction</c>
    /// fallback reported success without ever running the Click handler
    /// (<c>menu-status</c> stayed <c>idle</c>), where the identical click
    /// against an unmodified <see cref="Button"/> in the same process
    /// invoked correctly. Any override host whose target must still be
    /// clickable through the CLI therefore implements
    /// <see cref="IInvokeProvider"/> itself and delegates to the caller's
    /// own invoke callback, rather than relying on host delegation for
    /// click delivery.
    /// </summary>
    internal sealed class ControlTypeOverrideHost : UiaProviderHost
    {
        private readonly string automationId;
        private readonly int controlTypeId;
        private readonly Action invokeAction;

        internal ControlTypeOverrideHost(string automationId, int controlTypeId)
            : this(automationId, controlTypeId, null)
        {
        }

        internal ControlTypeOverrideHost(string automationId, int controlTypeId, Action invokeAction)
        {
            this.automationId = automationId;
            this.controlTypeId = controlTypeId;
            this.invokeAction = invokeAction;
        }

        protected override IRawElementProviderSimple CreateProvider(IntPtr handle)
        {
            return new Provider(this.automationId, this.controlTypeId, this.invokeAction, handle);
        }

        private sealed class Provider : IRawElementProviderSimple, IInvokeProvider
        {
            private readonly string automationId;
            private readonly int controlTypeId;
            private readonly Action invokeAction;
            private readonly IntPtr handle;

            internal Provider(string automationId, int controlTypeId, Action invokeAction, IntPtr handle)
            {
                this.automationId = automationId;
                this.controlTypeId = controlTypeId;
                this.invokeAction = invokeAction;
                this.handle = handle;
            }

            public ProviderOptions ProviderOptions
            {
                get { return ProviderOptions.ServerSideProvider; }
            }

            public object GetPatternProvider(int patternId)
            {
                if (this.invokeAction != null && patternId == InvokePatternIdentifiers.Pattern.Id)
                {
                    return this;
                }
                return null;
            }

            public object GetPropertyValue(int propertyId)
            {
                if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id)
                {
                    return this.controlTypeId;
                }
                if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id)
                {
                    return this.automationId;
                }
                if (this.invokeAction != null
                    && propertyId == AutomationElementIdentifiers.IsInvokePatternAvailableProperty.Id)
                {
                    return true;
                }
                return null;
            }

            /// <summary>
            /// UI Automation can deliver this call on any thread, and the
            /// action mutates a WinForms control. The two sibling providers
            /// in this corpus guard with InvokeRequired for the same reason;
            /// without it the menu-fire leg is an intermittent false pass or
            /// false fail depending on which thread UIA happened to use.
            /// </summary>
            public void Invoke()
            {
                if (this.invokeAction == null)
                {
                    return;
                }
                Control owner = Control.FromHandle(this.handle);
                if (owner != null && owner.InvokeRequired)
                {
                    owner.BeginInvoke((MethodInvoker)delegate { this.invokeAction(); });
                    return;
                }
                this.invokeAction();
            }

            public IRawElementProviderSimple HostRawElementProvider
            {
                get { return AutomationInteropProvider.HostProviderFromHandle(this.handle); }
            }
        }
    }
}
