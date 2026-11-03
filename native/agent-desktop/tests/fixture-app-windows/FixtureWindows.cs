using System;
using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach item 10: two real top-level <see cref="Form"/>s sharing the
    /// identical title <c>Duplicate Window</c> but carrying distinct
    /// <c>AutomationId</c>s, opened and closed together. Both are built
    /// eagerly at startup (so their ids are in the identity manifest) and
    /// hidden rather than closed on dismissal, for the same single-instance
    /// reuse reason as the occlusion overlay.
    /// </summary>
    internal static class FixtureWindows
    {
        internal static void Build(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Duplicate windows", 90);

            DuplicateWindow windowA = new DuplicateWindow("duplicate-window-a", new Point(120, 120));
            DuplicateWindow windowB = new DuplicateWindow("duplicate-window-b", new Point(360, 160));

            Button openDuplicates = new Button();
            FixtureIdentity.Assign(openDuplicates, "open-duplicate-windows");
            openDuplicates.Text = "Open duplicates";
            openDuplicates.Location = new Point(16, CardLayout.RowY(0));
            openDuplicates.Size = new Size(150, 26);
            openDuplicates.Click += delegate
            {
                windowA.Show();
                windowB.Show();
            };
            card.Controls.Add(openDuplicates);

            Button closeDuplicates = new Button();
            FixtureIdentity.Assign(closeDuplicates, "close-duplicate-windows");
            closeDuplicates.Text = "Close duplicates";
            closeDuplicates.Location = new Point(180, CardLayout.RowY(0));
            closeDuplicates.Size = new Size(150, 26);
            closeDuplicates.Click += delegate
            {
                windowA.Hide();
                windowB.Hide();
            };
            card.Controls.Add(closeDuplicates);
        }

        private sealed class DuplicateWindow : Form
        {
            internal DuplicateWindow(string automationId, Point location)
            {
                FixtureIdentity.Assign(this, automationId);
                this.Text = "Duplicate Window";
                this.StartPosition = FormStartPosition.Manual;
                this.Location = location;
                this.ClientSize = new Size(220, 120);
                this.ShowInTaskbar = false;

                this.FormClosing += delegate(object sender, FormClosingEventArgs e)
                {
                    e.Cancel = true;
                    this.Hide();
                };
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }
        }
    }
}
