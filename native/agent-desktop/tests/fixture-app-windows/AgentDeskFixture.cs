using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Assigns AutomationId through <see cref="Control.Name"/> - the only
    /// mechanism the stock WinForms UIA provider surfaces as AutomationId
    /// on this toolchain (A24-2) - and keeps a running inventory of every id
    /// assigned so the whole fixture's identity surface can be written out
    /// as a manifest. Going through this helper rather than setting
    /// <c>Name</c> directly is what makes a control added without an id a
    /// compile-time-visible omission: nothing else in this assembly is
    /// allowed to touch <c>Control.Name</c>.
    /// </summary>
    public static class FixtureIdentity
    {
        private static readonly List<string> RegisteredIds = new List<string>();

        public static void Assign(Control control, string automationId)
        {
            if (string.IsNullOrEmpty(automationId))
            {
                throw new ArgumentException(
                    "every fixture control must carry a non-empty AutomationId");
            }
            control.Name = automationId;
            RegisteredIds.Add(automationId);
        }

        /// <summary>
        /// Writes every id assigned so far, deduplicated and sorted, one per
        /// line, to AgentDeskFixture.ids.txt beside the running exe. The
        /// harness diffs this against its own declared inventory as a
        /// set-equality check, so a control deleted from the fixture and
        /// from the harness's list in one edit still fails the build rather
        /// than shrinking coverage silently.
        /// </summary>
        public static string WriteManifest(string directory)
        {
            SortedSet<string> unique = new SortedSet<string>(StringComparer.Ordinal);
            foreach (string id in RegisteredIds)
            {
                unique.Add(id);
            }
            string manifestPath = Path.Combine(directory, "AgentDeskFixture.ids.txt");
            string[] lines = new string[unique.Count];
            unique.CopyTo(lines);
            File.WriteAllLines(manifestPath, lines);
            return manifestPath;
        }
    }

    /// <summary>
    /// The fixture's single scrollable main form. The process exits when
    /// this specific form closes - <c>Application.Run(Form)</c> ties the
    /// message loop to this instance, so opening secondary windows (the
    /// duplicate-title targets a later card adds) never triggers an early
    /// exit when one of those closes first.
    /// </summary>
    public class AgentDeskFixture : Form
    {
        private const string RootAutomationId = "fixture-root";
        private const string SmokeStatusId = "smoke-status";
        private const string NoActivateEnvVar = "AGENT_DESKTOP_FIXTURE_NO_ACTIVATE";

        public AgentDeskFixture()
        {
            FixtureIdentity.Assign(this, RootAutomationId);
            this.Text = "AgentDeskFixture";
            this.Width = 900;
            this.Height = 650;
            this.AutoScroll = true;
            this.StartPosition = FormStartPosition.Manual;
            this.Location = new Point(40, 40);

            TextBox smokeStatus = FixtureStatus.Create(SmokeStatusId);
            smokeStatus.Location = new Point(20, 20);
            smokeStatus.Width = 260;
            this.Controls.Add(smokeStatus);

            FixtureStatus.SetValue(SmokeStatusId, "ready");

            LayoutCursor cursor = new LayoutCursor(52);
            FixtureCards.Build(this, cursor);
            FixtureAsync.Build(this, cursor);
            FixtureOcclusion.Build(this, cursor);
            FixtureWindows.Build(this, cursor);
            FixtureCellProvider.Build(this, cursor);

            this.AutoScrollMinSize = new Size(0, cursor.Bottom + 20);
        }

        /// <summary>
        /// Overridden so the framework's own show path uses
        /// SW_SHOWNOACTIVATE instead of activating the window, exactly when
        /// the launcher asked for it. Left at the WinForms default (false)
        /// whenever the env var is unset or not exactly "1", so every other
        /// leg gets ordinary activating behaviour.
        /// </summary>
        protected override bool ShowWithoutActivation
        {
            get { return NoActivateRequested(); }
        }

        private static bool NoActivateRequested()
        {
            return Environment.GetEnvironmentVariable(NoActivateEnvVar) == "1";
        }

        [STAThread]
        public static void Main()
        {
            AgentDeskFixture form = new AgentDeskFixture();

            string exeDirectory = Path.GetDirectoryName(
                Assembly.GetExecutingAssembly().Location);
            FixtureIdentity.WriteManifest(exeDirectory);

            form.Show();
            Application.Run(form);
        }
    }
}
