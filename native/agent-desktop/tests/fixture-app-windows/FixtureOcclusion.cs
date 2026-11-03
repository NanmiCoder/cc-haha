using System;
using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach item 11 and KTD9: the occlusion class is designed fresh
    /// rather than mirrored from the macOS fixture, which has no occlusion
    /// element at all. The Windows precedent is this crate's own
    /// <c>tree/fixture/fixture_overlay.rs</c>, whose overlay is named so a hit-test
    /// assertion can prove which window intercepted; this reproduces that
    /// shape as a real top-most <see cref="Form"/> named
    /// <c>fixture-overlay</c>, opened and closed by two buttons so the
    /// harness can drive it through the CLI rather than from in-process
    /// test code.
    /// </summary>
    internal static class FixtureOcclusion
    {
        internal static void Build(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Occlusion", 90);

            Button occludedButton = new Button();
            FixtureIdentity.Assign(occludedButton, "occluded-button");
            occludedButton.Text = "Occluded";
            occludedButton.Location = new Point(16, CardLayout.RowY(0));
            occludedButton.Size = new Size(110, 26);
            card.Controls.Add(occludedButton);
            occludedButton.Click += delegate { FixtureStatus.SetValue("occlusion-status", "clicked"); };
            TextBox occlusionStatus = FixtureStatus.Create("occlusion-status");
            occlusionStatus.Location = new Point(140, CardLayout.RowY(0));
            occlusionStatus.Width = 200;
            card.Controls.Add(occlusionStatus);

            OverlayForm overlay = new OverlayForm();

            Button openOccluder = new Button();
            FixtureIdentity.Assign(openOccluder, "open-occluder");
            openOccluder.Text = "Open occluder";
            openOccluder.Location = new Point(360, CardLayout.RowY(0));
            openOccluder.Size = new Size(130, 26);
            openOccluder.Click += delegate
            {
                Rectangle screenBounds = new Rectangle(
                    occludedButton.PointToScreen(Point.Empty), occludedButton.Size);
                overlay.CoverAndShow(screenBounds);
            };
            card.Controls.Add(openOccluder);

            Button closeOccluder = new Button();
            FixtureIdentity.Assign(closeOccluder, "close-occluder");
            closeOccluder.Text = "Close occluder";
            closeOccluder.Location = new Point(500, CardLayout.RowY(0));
            closeOccluder.Size = new Size(130, 26);
            closeOccluder.Click += delegate { overlay.Hide(); };
            card.Controls.Add(closeOccluder);
        }

        /// <summary>
        /// Built once at fixture startup (so <c>fixture-overlay</c> is
        /// registered in the identity manifest even though the form is not
        /// shown until <c>open-occluder</c> is clicked) and hidden rather
        /// than closed, so the same instance - and the same
        /// <c>AutomationId</c> - serves every open/close cycle in the
        /// process's lifetime.
        /// </summary>
        private sealed class OverlayForm : Form
        {
            internal OverlayForm()
            {
                FixtureIdentity.Assign(this, "fixture-overlay");
                this.Text = "fixture-overlay";
                this.FormBorderStyle = FormBorderStyle.None;
                this.TopMost = true;
                this.ShowInTaskbar = false;
                this.StartPosition = FormStartPosition.Manual;
                this.BackColor = Color.Firebrick;

                this.FormClosing += delegate(object sender, FormClosingEventArgs e)
                {
                    e.Cancel = true;
                    this.Hide();
                };
            }

            internal void CoverAndShow(Rectangle screenBounds)
            {
                this.Bounds = screenBounds;
                this.Show();
                this.BringToFront();
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }
        }
    }
}
