using System;
using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach item 1: clicks and mouse.
    /// </summary>
    internal static partial class FixtureCards
    {
        private static void BuildClicksAndMouse(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Clicks and mouse", 260);

            Button primary = NewButton(card, "primary-button", "Primary", 16, CardLayout.RowY(0), 110);
            primary.Click += delegate { FixtureStatus.SetValue("click-status", "clicked"); };
            NewStatus(card, "click-status", 140, CardLayout.RowY(0), 200);

            BuildCountedClickTarget(card, "double-target", "Double", CardLayout.RowY(1), "double-status", "double-clicked", 2);
            NewStatus(card, "double-status", 140, CardLayout.RowY(1), 200);

            BuildCountedClickTarget(card, "triple-target", "Triple", CardLayout.RowY(2), "triple-status", "triple-clicked", 3);
            NewStatus(card, "triple-status", 140, CardLayout.RowY(2), 200);

            Button contextTarget = NewButton(card, "context-target", "Context", 16, CardLayout.RowY(3), 110);
            BuildContextChoicePopup(contextTarget);
            NewStatus(card, "context-status", 140, CardLayout.RowY(3), 200);

            Button hoverTarget = NewButton(card, "hover-target", "Hover", 16, CardLayout.RowY(4), 110);
            hoverTarget.MouseEnter += delegate { FixtureStatus.SetValue("hover-status", "hovered"); };
            NewStatus(card, "hover-status", 140, CardLayout.RowY(4), 200);

            BuildTwinControls(card, CardLayout.RowY(5));
        }

        private static void BuildCountedClickTarget(
            GroupBox card, string id, string label, int y, string statusId, string statusValue, int targetCount)
        {
            CountedClickButton target = CountedClickButton.Create(card, id, label, 16, y, 110);
            int clickCount = 0;
            DateTime windowStart = DateTime.MinValue;
            target.MouseUp += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) { return; }
                DateTime now = DateTime.UtcNow;
                double windowMs = SystemInformation.DoubleClickTime * 2;
                if (clickCount == 0 || (now - windowStart).TotalMilliseconds > windowMs)
                {
                    clickCount = 1;
                    windowStart = now;
                }
                else
                {
                    clickCount = clickCount + 1;
                }
                if (clickCount >= targetCount)
                {
                    FixtureStatus.SetValue(statusId, statusValue);
                    clickCount = 0;
                }
            };
        }

        private static void BuildTwinControls(GroupBox card, int y)
        {
            Button twinA = new Button();
            FixtureIdentity.Assign(twinA, "twin-control");
            twinA.Text = "Twin";
            twinA.Location = new Point(16, y);
            twinA.Size = new Size(90, 26);
            card.Controls.Add(twinA);

            Button twinB = new Button();
            FixtureIdentity.Assign(twinB, "twin-control");
            twinB.Text = "Twin";
            twinB.Location = new Point(112, y);
            twinB.Size = new Size(90, 26);
            card.Controls.Add(twinB);

            Button moveTwins = NewButton(card, "move-twins", "Move twins", 210, y, 110);
            // Translating Location alone does not defeat a stored ref for
            // either twin: agent-desktop's Windows resolver re-identifies a
            // ref by its stored child-index tree path before it ever reaches
            // the bounds-hash tie-break (can_use_path_fast_path,
            // crates/windows/src/tree/resolve/resolve_search.rs), and a bare location
            // change leaves both twins at their original Controls indices -
            // the path lands on the exact original element, which is a
            // correct re-identification, not an ambiguity. Removing and
            // re-adding both twins shifts every later sibling's index
            // (moveTwins included), so the stored path for the stale twin now
            // lands on a control whose identity does not match and the
            // resolver falls through to the broad search. Only then do two
            // evidence-identical candidates reach the bounds-hash tier, and
            // only then does moving both defeat that tie-break too.
            moveTwins.Click += delegate
            {
                int dx = 14;
                card.Controls.Remove(twinA);
                card.Controls.Remove(twinB);
                twinA.Location = new Point(twinA.Location.X + dx, twinA.Location.Y);
                twinB.Location = new Point(twinB.Location.X + dx, twinB.Location.Y);
                card.Controls.Add(twinA);
                card.Controls.Add(twinB);
            };
        }

        /// <summary>
        /// A real <see cref="ContextMenuStrip"/> was tried first - it is
        /// the obvious, zero-custom-code shape for "right-click, choose an
        /// item" - and did not survive the read-back loop: its item is a
        /// <see cref="ToolStripMenuItem"/>, and <c>ToolStripItem.Name</c>
        /// does not surface as <c>AutomationId</c> (the same finding that
        /// moved <c>menu-fire-item</c> and <c>menu-disclosure</c> off
        /// <see cref="ToolStripItem"/>-based shapes); measured live,
        /// <c>find --native-id context-choice</c> against a real running
        /// build returned zero matches even with the native context menu
        /// genuinely open (a real right-click delivered headed, confirmed
        /// by <c>right-click</c>'s own success). What ships instead is a
        /// borderless, non-modal <see cref="Form"/> - the same
        /// show/hide-on-<see cref="Form.FormClosing"/> reuse pattern as
        /// <c>fixture-overlay</c> and the duplicate windows - carrying a
        /// real <see cref="Button"/> for <c>context-choice</c>, appearing at
        /// the right-click point. It sacrifices genuine Win32 menu semantics
        /// (no <c>ControlType.Menu</c> family role on this surface) for the
        /// one property R2 makes non-negotiable: the staged id actually
        /// resolves by <c>--native-id</c> while its surface is up. A first
        /// build dismissed itself on <see cref="Form.Deactivate"/> to mimic
        /// a real context menu's click-elsewhere dismissal; measured live
        /// against the harness, a spawned CLI process's own right-click
        /// call reliably moves OS foreground away from this popup within
        /// its own process lifetime, so <c>Deactivate</c> fired and hid the
        /// window before the harness's own poll could observe it open -
        /// the same resolves-while-up property R2 asks for, defeated by a
        /// dismissal rule this surface never needed: both callers already
        /// dismiss it explicitly by clicking <c>context-choice</c>.
        /// </summary>
        private static void BuildContextChoicePopup(Control contextTarget)
        {
            Form popup = new Form();
            popup.FormBorderStyle = FormBorderStyle.None;
            popup.ShowInTaskbar = false;
            popup.StartPosition = FormStartPosition.Manual;
            popup.Size = new Size(120, 32);

            Button choice = new Button();
            FixtureIdentity.Assign(choice, "context-choice");
            choice.Text = "Choose";
            choice.Dock = DockStyle.Fill;
            popup.Controls.Add(choice);

            popup.FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                e.Cancel = true;
                popup.Hide();
            };
            choice.Click += delegate
            {
                FixtureStatus.SetValue("context-status", "chosen");
                popup.Hide();
            };

            contextTarget.MouseUp += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Right)
                {
                    popup.Location = contextTarget.PointToScreen(new Point(e.X, e.Y));
                    popup.Show();
                }
            };
        }

    internal sealed class CountedClickButton : Button
    {
        internal CountedClickButton()
        {
            SetStyle(ControlStyles.StandardClick | ControlStyles.StandardDoubleClick, true);
        }

        internal static CountedClickButton Create(
            GroupBox card, string id, string text, int x, int y, int width)
        {
            CountedClickButton button = new CountedClickButton();
            FixtureIdentity.Assign(button, id);
            button.Text = text;
            button.SetBounds(x, y, width, 26);
            card.Controls.Add(button);
            return button;
        }
    }
}
}
