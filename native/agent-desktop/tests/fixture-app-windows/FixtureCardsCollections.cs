using System;
using System.Drawing;
using System.Windows.Automation;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach item 5: collections and disclosure.
    /// </summary>
    internal static partial class FixtureCards
    {
        private static void BuildCollectionsAndDisclosure(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Collections and disclosure", 300);

            BuildOutlineTree(card, CardLayout.RowY(0));
            BuildMenuDisclosure(card, 260, CardLayout.RowY(0));
            BuildItemList(card, 16, CardLayout.RowY(0) + 130);
            BuildMenuStrip(card, 400, CardLayout.RowY(0) + 130);
        }

        /// <summary>
        /// <c>TreeView</c>'s stock provider gives the <em>container</em> a
        /// working <c>AutomationId</c> from <c>Control.Name</c> (measured
        /// live), but <c>TreeNode.Name</c> does not surface as
        /// <c>AutomationId</c> at all - a <see cref="TreeNode"/> is not a
        /// <see cref="Control"/>, so it never reaches the identity path
        /// A24-2 measured. Confirmed by driving a real build of this
        /// fixture through <c>agent-desktop find --native-id
        /// outline-parent</c>: zero matches against the stock
        /// <see cref="TreeView"/> shape. So the whole outline, container and
        /// items alike, is built from real <see cref="Control"/>s wearing
        /// <see cref="ControlTypeOverrideHost"/> / <see cref="ExpandCollapseButtonHost"/>
        /// overrides - the same mechanism already proven for
        /// <c>switch-button</c> and the cell targets - arranged with
        /// indentation to read as a tree, rather than a real
        /// <see cref="TreeView"/>. All three items stay resident and
        /// visible regardless of <c>outline-parent</c>'s expand/collapse
        /// state (the plan's resident/staged split places them as
        /// resident), so KTD8's expand/collapse assertion is carried purely
        /// by <c>outline-parent</c>'s own reported
        /// <c>ExpandCollapseState</c>, read back through <c>get</c>.
        /// </summary>
        private static void BuildOutlineTree(GroupBox card, int y)
        {
            Panel outlineTree = new Panel();
            FixtureIdentity.Assign(outlineTree, "outline-tree");
            outlineTree.Location = new Point(16, y);
            outlineTree.Size = new Size(220, 110);
            outlineTree.BorderStyle = BorderStyle.FixedSingle;
            card.Controls.Add(outlineTree);
            new ControlTypeOverrideHost("outline-tree", ControlType.Tree.Id).Hook(outlineTree);

            Label parentLabel = new Label();
            FixtureIdentity.Assign(parentLabel, "outline-parent");
            parentLabel.Text = "Parent";
            parentLabel.Location = new Point(4, 4);
            parentLabel.AutoSize = true;
            outlineTree.Controls.Add(parentLabel);
            ExpandCollapseButtonHost parentHost = new ExpandCollapseButtonHost(
                parentLabel, "outline-parent", ControlType.TreeItem.Id);
            parentHost.Hook(parentLabel);
            parentHost.StateChanged += delegate
            {
                parentLabel.Text = (parentHost.CurrentState == ExpandCollapseState.Expanded)
                    ? "Parent (expanded)"
                    : "Parent";
            };

            Label childA = new Label();
            FixtureIdentity.Assign(childA, "outline-child-a");
            childA.Text = "Child A";
            childA.Location = new Point(20, 28);
            childA.AutoSize = true;
            outlineTree.Controls.Add(childA);
            new ControlTypeOverrideHost("outline-child-a", ControlType.TreeItem.Id).Hook(childA);

            Label childB = new Label();
            FixtureIdentity.Assign(childB, "outline-child-b");
            childB.Text = "Child B";
            childB.Location = new Point(20, 48);
            childB.AutoSize = true;
            outlineTree.Controls.Add(childB);
            new ControlTypeOverrideHost("outline-child-b", ControlType.TreeItem.Id).Hook(childB);
        }

        /// <summary>
        /// <see cref="ToolStripSplitButton"/> was tried first for the
        /// zero-custom-code <c>ControlType.SplitButton</c> shape and did not
        /// survive the read-back loop for the same reason
        /// <c>menu-fire-item</c> did not: <c>ToolStripItem.Name</c> does not
        /// surface as <c>AutomationId</c>. What ships is the
        /// <see cref="ExpandCollapseButtonHost"/> shape on a real
        /// <see cref="Button"/>.
        /// </summary>
        private static void BuildMenuDisclosure(GroupBox card, int x, int y)
        {
            Button menuDisclosure = NewButton(card, "menu-disclosure", "Disclosure", x, y, 120);
            ExpandCollapseButtonHost host = new ExpandCollapseButtonHost(menuDisclosure, "menu-disclosure");
            host.Hook(menuDisclosure);
            host.StateChanged += delegate
            {
                menuDisclosure.Text = (host.CurrentState == ExpandCollapseState.Expanded)
                    ? "Disclosure: open"
                    : "Disclosure: closed";
            };
            menuDisclosure.Click += delegate
            {
                if (host.CurrentState == ExpandCollapseState.Expanded)
                {
                    host.CollapseNow();
                }
                else
                {
                    host.ExpandNow();
                }
            };
        }

        private static void BuildItemList(GroupBox card, int x, int y)
        {
            ListBox itemList = new ListBox();
            FixtureIdentity.Assign(itemList, "item-list");
            itemList.Location = new Point(x, y);
            itemList.Size = new Size(200, 110);
            for (int i = 1; i <= 6; i++)
            {
                itemList.Items.Add("Item " + i.ToString());
            }
            card.Controls.Add(itemList);
        }

        /// <summary>
        /// A top-level <see cref="MenuStrip"/> item was the plan's original
        /// design ("a provider at rest, resolvable without opening
        /// anything"), but <c>ToolStripMenuItem.Name</c> does not surface as
        /// <c>AutomationId</c> either - measured the same way, zero matches
        /// on <c>--native-id menu-fire-item</c> against a real running
        /// build. <c>ControlType.MenuItem</c> requires no pattern-gated
        /// refinement (<c>roles.rs</c> maps it unconditionally), so a plain
        /// <see cref="Button"/> wearing a <see cref="ControlTypeOverrideHost"/>
        /// keeps the "resident, no menu-mode needed, dispatchable through
        /// the semantic tier" property the plan wanted from the MenuStrip
        /// shape while actually resolving by id.
        /// </summary>
        private static void BuildMenuStrip(GroupBox card, int x, int y)
        {
            Button fireItem = NewButton(card, "menu-fire-item", "Fire", x, y, 100);
            EventHandler fire = delegate { FixtureStatus.SetValue("menu-status", "fired"); };
            ControlTypeOverrideHost fireHost = new ControlTypeOverrideHost(
                "menu-fire-item", ControlType.MenuItem.Id, delegate { fire(fireItem, EventArgs.Empty); });
            fireHost.Hook(fireItem);
            fireItem.Click += fire;
            NewStatus(card, "menu-status", x + 110, y, 200);
        }
    }
}
