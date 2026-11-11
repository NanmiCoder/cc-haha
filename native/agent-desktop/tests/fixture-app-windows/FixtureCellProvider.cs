using System;
using System.Drawing;
using System.Windows.Automation;
using System.Windows.Automation.Provider;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Three <c>WM_GETOBJECT</c> providers presenting the three shapes
    /// <c>roles.rs</c>'s <c>data_item_role</c> and <c>custom_role</c>
    /// refinements care about, using the exact mechanism
    /// <c>probes/windows/24-fixture-e2e/06-cell-role-provider.ps1</c> proved
    /// compiles and reads back on this toolchain (A24-9):
    ///
    /// <list type="bullet">
    /// <item><c>cell-griditem</c> - <c>ControlType.DataItem</c> plus
    /// <c>GridItem</c>/<c>TableItem</c>, which <c>data_item_role</c> refines
    /// to <see cref="Role.Cell"/>.</item>
    /// <item><c>cell-custom</c> - <c>ControlType.Custom</c> plus the same two
    /// patterns - the shape WPF's real <c>DataGrid</c> exposes (A16-10) -
    /// which <c>custom_role</c> also refines to <see cref="Role.Cell"/>.</item>
    /// <item><c>row-plain</c> - <c>ControlType.DataItem</c> with neither
    /// pattern, the negative case neither refinement disturbs -
    /// <c>data_item_role</c> resolves it to <see cref="Role.Row"/>.</item>
    /// </list>
    /// </summary>
    internal static class FixtureCellProvider
    {
        internal static void Build(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Cell and row", 90);

            Panel gridPanel = new Panel();
            FixtureIdentity.Assign(gridPanel, "grid-panel");
            gridPanel.Location = new Point(16, CardLayout.RowY(0));
            gridPanel.Size = new Size(500, 40);
            card.Controls.Add(gridPanel);

            Panel cellGridItem = new Panel();
            cellGridItem.Location = new Point(4, 4);
            cellGridItem.Size = new Size(150, 30);
            gridPanel.Controls.Add(cellGridItem);
            CellShapeHost gridItemHost = new CellShapeHost(
                "cell-griditem", ControlType.DataItem.Id, true, 0, 0);
            gridItemHost.Hook(cellGridItem);

            Panel cellCustom = new Panel();
            cellCustom.Location = new Point(170, 4);
            cellCustom.Size = new Size(150, 30);
            gridPanel.Controls.Add(cellCustom);
            CellShapeHost customHost = new CellShapeHost(
                "cell-custom", ControlType.Custom.Id, true, 0, 1);
            customHost.Hook(cellCustom);

            Panel rowPlain = new Panel();
            rowPlain.Location = new Point(336, 4);
            rowPlain.Size = new Size(150, 30);
            gridPanel.Controls.Add(rowPlain);
            CellShapeHost rowHost = new CellShapeHost(
                "row-plain", ControlType.DataItem.Id, false, 1, 0);
            rowHost.Hook(rowPlain);
        }

        /// <summary>
        /// Answers <c>ControlType</c>, <c>AutomationId</c> and, when
        /// <paramref name="advertisePatterns"/> is true, <c>GridItem</c> and
        /// <c>TableItem</c> availability plus the pattern objects themselves
        /// - implementing both on one object, as the probe does, since a
        /// real grid cell answers both patterns together rather than one at
        /// a time.
        /// </summary>
        private sealed class CellShapeHost : UiaProviderHost
        {
            private readonly string automationId;
            private readonly int controlTypeId;
            private readonly bool advertisePatterns;
            private readonly int row;
            private readonly int column;

            internal CellShapeHost(
                string automationId, int controlTypeId, bool advertisePatterns, int row, int column)
            {
                this.automationId = automationId;
                this.controlTypeId = controlTypeId;
                this.advertisePatterns = advertisePatterns;
                this.row = row;
                this.column = column;
            }

            protected override IRawElementProviderSimple CreateProvider(IntPtr handle)
            {
                return new Provider(this, handle);
            }

            private sealed class Provider :
                IRawElementProviderSimple, IGridItemProvider, ITableItemProvider
            {
                private readonly CellShapeHost host;
                private readonly IntPtr handle;

                internal Provider(CellShapeHost host, IntPtr handle)
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
                    if (!this.host.advertisePatterns)
                    {
                        return null;
                    }
                    if (patternId == GridItemPatternIdentifiers.Pattern.Id)
                    {
                        return this;
                    }
                    if (patternId == TableItemPatternIdentifiers.Pattern.Id)
                    {
                        return this;
                    }
                    return null;
                }

                public object GetPropertyValue(int propertyId)
                {
                    if (propertyId == AutomationElementIdentifiers.ControlTypeProperty.Id)
                    {
                        return this.host.controlTypeId;
                    }
                    if (propertyId == AutomationElementIdentifiers.AutomationIdProperty.Id)
                    {
                        return this.host.automationId;
                    }
                    if (propertyId == AutomationElementIdentifiers.IsGridItemPatternAvailableProperty.Id)
                    {
                        return this.host.advertisePatterns;
                    }
                    if (propertyId == AutomationElementIdentifiers.IsTableItemPatternAvailableProperty.Id)
                    {
                        return this.host.advertisePatterns;
                    }
                    return null;
                }

                public IRawElementProviderSimple HostRawElementProvider
                {
                    get { return AutomationInteropProvider.HostProviderFromHandle(this.handle); }
                }

                public int Row
                {
                    get { return this.host.row; }
                }

                public int Column
                {
                    get { return this.host.column; }
                }

                public int RowSpan
                {
                    get { return 1; }
                }

                public int ColumnSpan
                {
                    get { return 1; }
                }

                public IRawElementProviderSimple ContainingGrid
                {
                    get { return this; }
                }

                public IRawElementProviderSimple[] GetRowHeaderItems()
                {
                    return new IRawElementProviderSimple[0];
                }

                public IRawElementProviderSimple[] GetColumnHeaderItems()
                {
                    return new IRawElementProviderSimple[0];
                }
            }
        }
    }
}
