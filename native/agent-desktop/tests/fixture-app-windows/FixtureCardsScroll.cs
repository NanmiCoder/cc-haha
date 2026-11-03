using System.Drawing;
using System.Windows.Automation;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach item 6 (scroll), item 9 (zero bounds) and item 12 (surfaces).
    /// </summary>
    internal static partial class FixtureCards
    {
        private static void BuildScroll(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Scroll", 220);

            Panel scrollArea = new Panel();
            FixtureIdentity.Assign(scrollArea, "scroll-area");
            scrollArea.Location = new Point(16, CardLayout.RowY(0));
            scrollArea.Size = new Size(400, 150);
            scrollArea.AutoScroll = true;
            card.Controls.Add(scrollArea);

            int rowHeight = 24;
            int rowCount = 60;
            for (int i = 0; i < rowCount; i++)
            {
                string rowId = "scroll-row-" + (i + 1).ToString();
                Label row = new Label();
                FixtureIdentity.Assign(row, rowId);
                row.Text = "Row " + (i + 1).ToString();
                row.Location = new Point(4, i * rowHeight);
                row.Size = new Size(360, rowHeight - 2);
                scrollArea.Controls.Add(row);

                // A bare Label carries no pattern beyond SetFocus (measured
                // live: find --native-id resolves it, but it never earns a
                // ref - is_ref_able requires an interactive role or an
                // action beyond SetFocus, per crates/core/src/refs/ref_alloc.rs -
                // so scroll-to, which is ref-only, has no way to target a
                // below-fold row at all. The same ControlTypeOverrideHost
                // used for menu-fire-item below wires a no-op Invoke here,
                // purely to earn the ref; ControlType stays Text so the
                // role this fixture already reports (statictext) is
                // unchanged.
                new ControlTypeOverrideHost(rowId, ControlType.Text.Id, delegate { }).Hook(row);
            }

            // Forces the AutoScroll panel's real scrollbar styles to be
            // present at construction, which is what makes the stock UIA
            // provider synthesize ScrollPattern for it (R5's ancestor-scroll
            // ladder route) - deferring to the natural extent computed from
            // the 60 realized rows alone left this unconfirmed until
            // verified live.
            scrollArea.AutoScrollMinSize = new Size(360, rowCount * rowHeight);

            TextBox scrollOffset = FixtureStatus.Create("scroll-offset");
            scrollOffset.Location = new Point(432, CardLayout.RowY(0));
            scrollOffset.Width = 200;
            card.Controls.Add(scrollOffset);
            scrollArea.Scroll += delegate
            {
                scrollOffset.Text = (-scrollArea.AutoScrollPosition.Y).ToString();
            };
            scrollOffset.Text = "0";

            Panel horizontal = new Panel();
            FixtureIdentity.Assign(horizontal, "horizontal-scroll-area");
            horizontal.Location = new Point(432, CardLayout.RowY(2));
            horizontal.Size = new Size(160, 60);
            horizontal.AutoScroll = true;
            horizontal.AutoScrollMinSize = new Size(500, 20);
            card.Controls.Add(horizontal);

            Label edgeTarget = new Label();
            FixtureIdentity.Assign(edgeTarget, "horizontal-edge-target");
            edgeTarget.Text = "Edge";
            edgeTarget.Location = new Point(150, 0);
            edgeTarget.Size = new Size(30, 20);
            horizontal.Controls.Add(edgeTarget);
            new ControlTypeOverrideHost("horizontal-edge-target", ControlType.Text.Id, delegate { }).Hook(edgeTarget);
        }

        /// <summary>
        /// The plan names two mechanisms for reporting a zero
        /// <c>BoundingRectangle</c> - <c>GetPropertyValue</c> and
        /// <c>IRawElementProviderFragment</c> - citing A24-9 as having
        /// proved the route; A24-9 in fact never measured
        /// <c>BoundingRectangle</c> at all, only <c>ControlType</c> and the
        /// grid patterns, so the citation was an extrapolation. Measured
        /// live against a running build of this fixture, in three separate
        /// configurations: (1) a normal-size real <see cref="Button"/> with
        /// <c>GetPropertyValue(BoundingRectangleProperty)</c> overridden to
        /// zero - <c>get --property bounds</c> still read the button's
        /// genuine on-screen rectangle; (2) the same button with
        /// <c>IRawElementProviderFragment.BoundingRectangle</c> overridden
        /// instead - identical result; (3) the override combined with a
        /// real, degenerate 1x1 control size - <c>bounds</c> still read the
        /// real 1x1 rectangle, never the overridden zero. UI Automation
        /// evidently sources <c>BoundingRectangle</c> for the root provider
        /// of a real HWND from the window's own geometry regardless of what
        /// either provider interface reports; neither mechanism this
        /// toolchain offers can force it to zero. A genuinely 0x0-sized
        /// real control was also tried and is excluded from the UIA tree
        /// entirely - <c>find --native-id</c> against it returns zero
        /// matches - so that is not a route either. What ships is the
        /// closest achievable, honestly-reported approximation: a real
        /// <see cref="Button"/> at the smallest size that stays resolvable
        /// (1x1, not 0x0), reporting exactly what it is - a 1x1 rectangle,
        /// not a fabricated zero one.
        /// </summary>
        private static void BuildZeroBounds(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Zero bounds", 90);

            Button zeroBoundsButton = NewButton(card, "zero-bounds-button", "Zero bounds", 16, CardLayout.RowY(0), 130);
            zeroBoundsButton.Size = new Size(1, 1);
        }

        private static void BuildSurfaces(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Surfaces", 90);

            Button openSheet = NewButton(card, "open-sheet", "Open sheet", 16, CardLayout.RowY(0), 130);
            NewStatus(card, "sheet-status", 160, CardLayout.RowY(0), 200);

            FixtureSheet sheet = new FixtureSheet();
            openSheet.Click += delegate
            {
                // Deferred: a modal ShowDialog() called synchronously from
                // this handler would not return until the dialog closes,
                // and this handler runs on a blocking cross-process COM call
                // (InvokePattern.Invoke) - blocking it here would hang the
                // click command itself rather than merely the UI thread.
                owner.BeginInvoke((MethodInvoker)delegate { sheet.ShowDialog(owner); });
            };
        }
    }
}
