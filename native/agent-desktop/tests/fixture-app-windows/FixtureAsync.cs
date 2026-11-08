using System;
using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach items 7 and 8: the delayed-enable card (the auto-wait
    /// budget's own positive leg) and the dynamic-tree card (an
    /// appear-later control and a removable row for the <c>STALE_REF</c>
    /// case). Every timed effect here runs off a one-shot
    /// <see cref="Timer"/> armed by a resident button, never off a timer
    /// that starts ticking at process launch - the harness controls exactly
    /// when the clock starts.
    /// </summary>
    internal static class FixtureAsync
    {
        private const int DelayedEnableMilliseconds = 4000;
        private const int AppearLaterMilliseconds = 1000;
        private const string NotReadySentinel = "not-ready";

        internal static void Build(Form owner, LayoutCursor cursor)
        {
            BuildDelayedEnable(owner, cursor);
            BuildDynamicTree(owner, cursor);
        }

        /// <summary>
        /// The delay is 4s rather than ~800ms: a harness leg's "immediately
        /// after" is a full round trip through a spawned CLI process (a
        /// click, a snapshot, a find, then another cold process start for
        /// the follow-up click), which comfortably exceeds 800ms on its
        /// own - at that delay the click would land on an already-enabled
        /// button and the leg would pass with the auto-wait loop deleted
        /// entirely.
        /// </summary>
        private static void BuildDelayedEnable(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Delayed enable", 130);

            TextBox delayedText = FixtureStatus.Create("delayed-text");
            delayedText.Text = NotReadySentinel;
            delayedText.Location = new Point(226, CardLayout.RowY(0));
            delayedText.Width = 160;
            card.Controls.Add(delayedText);

            Button delayedButton = new Button();
            FixtureIdentity.Assign(delayedButton, "delayed-button");
            delayedButton.Text = "Delayed action";
            delayedButton.Location = new Point(226, CardLayout.RowY(1));
            delayedButton.Size = new Size(150, 26);
            delayedButton.Enabled = false;
            card.Controls.Add(delayedButton);
            delayedButton.Click += delegate { FixtureStatus.SetValue("delayed-action-status", "acted"); };
            TextBox delayedActionStatus = FixtureStatus.Create("delayed-action-status");
            delayedActionStatus.Location = new Point(386, CardLayout.RowY(1));
            delayedActionStatus.Width = 180;
            card.Controls.Add(delayedActionStatus);

            Timer armedTimer = new Timer();
            armedTimer.Interval = DelayedEnableMilliseconds;
            armedTimer.Tick += delegate
            {
                armedTimer.Stop();
                delayedText.Text = "ready";
                delayedButton.Enabled = true;
            };

            Button enableLater = new Button();
            FixtureIdentity.Assign(enableLater, "enable-later");
            enableLater.Text = "Enable later";
            enableLater.Location = new Point(16, CardLayout.RowY(0));
            enableLater.Size = new Size(110, 26);
            enableLater.Click += delegate
            {
                armedTimer.Stop();
                armedTimer.Start();
            };
            card.Controls.Add(enableLater);

            Button permanentlyDisabled = new Button();
            FixtureIdentity.Assign(permanentlyDisabled, "permanently-disabled");
            permanentlyDisabled.Text = "Never enabled";
            permanentlyDisabled.Location = new Point(16, CardLayout.RowY(1));
            permanentlyDisabled.Size = new Size(150, 26);
            permanentlyDisabled.Enabled = false;
            card.Controls.Add(permanentlyDisabled);

            Button resetDelayed = new Button();
            FixtureIdentity.Assign(resetDelayed, "reset-delayed-button");
            resetDelayed.Text = "Reset";
            resetDelayed.Location = new Point(16, CardLayout.RowY(2));
            resetDelayed.Size = new Size(110, 26);
            resetDelayed.Click += delegate
            {
                armedTimer.Stop();
                delayedText.Text = NotReadySentinel;
                delayedButton.Enabled = false;
            };
            card.Controls.Add(resetDelayed);
        }

        private static void BuildDynamicTree(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Dynamic tree", 130);

            // A read-only TextBox, not a Label - KTD7 rejects the Label
            // shape outright (its only readable slot would be Name, one
            // slot doing duty for both identity and live value), and this
            // is a literal-value readout like delayed-text, so it bypasses
            // FixtureStatus.SetValue's counter suffix and is written to
            // directly.
            TextBox appearedText = FixtureStatus.Create("appeared-text");
            appearedText.Text = "not-appeared";
            appearedText.Location = new Point(226, CardLayout.RowY(0));
            appearedText.Width = 160;
            appearedText.Visible = false;
            card.Controls.Add(appearedText);

            Timer appearTimer = new Timer();
            appearTimer.Interval = AppearLaterMilliseconds;
            appearTimer.Tick += delegate
            {
                appearTimer.Stop();
                appearedText.Text = "appeared";
                appearedText.Visible = true;
            };

            Button appearLater = new Button();
            FixtureIdentity.Assign(appearLater, "appear-later");
            appearLater.Text = "Appear later";
            appearLater.Location = new Point(16, CardLayout.RowY(0));
            appearLater.Size = new Size(110, 26);
            appearLater.Click += delegate
            {
                appearTimer.Stop();
                appearTimer.Start();
            };
            card.Controls.Add(appearLater);

            Button resetAppeared = new Button();
            FixtureIdentity.Assign(resetAppeared, "reset-appeared-text");
            resetAppeared.Text = "Reset appeared";
            resetAppeared.Location = new Point(16, CardLayout.RowY(1));
            resetAppeared.Size = new Size(150, 26);
            resetAppeared.Click += delegate
            {
                appearTimer.Stop();
                appearedText.Text = "not-appeared";
                appearedText.Visible = false;
            };
            card.Controls.Add(resetAppeared);

            BuildRemovableRow(card, CardLayout.RowY(2));
        }

        /// <summary>
        /// <c>removable-row</c> resolves at rest, is the target of a
        /// <c>snapshot</c>/<c>find</c> before it is ever touched, and then
        /// <c>remove-row</c> removes it from the live tree entirely - the
        /// harness's <c>STALE_REF</c> leg acts on the pre-removal ref
        /// afterward. It has to be an actionable <see cref="Button"/>
        /// rather than a plain <see cref="Label"/>: a non-interactive
        /// static-text element is never allocated a ref at all (the ref
        /// system's own rule - "static text ... do NOT get refs"), so a
        /// <c>find</c> against a <see cref="Label"/> version of this target
        /// returns <c>ref_id: null</c> and there is no ref for the
        /// <c>STALE_REF</c> leg to act on later - measured live against a
        /// first draft of this fixture. Toggling <see cref="Control.Visible"/>
        /// rather than disposing keeps <c>reset-removable</c> able to bring
        /// the exact same control (and therefore the exact same
        /// <c>AutomationId</c>) back for the next leg without re-registering
        /// it. Clicking <c>removable-row</c> writes <c>removable-status</c>,
        /// the independent readout a leg reads to prove a click on a removed
        /// ref delivered nothing and a click on a fresh ref delivered.
        /// </summary>
        private static void BuildRemovableRow(GroupBox card, int y)
        {
            Button removableRow = new Button();
            FixtureIdentity.Assign(removableRow, "removable-row");
            removableRow.Text = "Removable row";
            removableRow.Location = new Point(226, y);
            removableRow.Size = new Size(150, 26);
            removableRow.Click += delegate { FixtureStatus.SetValue("removable-status", "row-clicked"); };
            card.Controls.Add(removableRow);

            TextBox removableStatus = FixtureStatus.Create("removable-status");
            removableStatus.Location = new Point(386, y);
            removableStatus.Width = 180;
            card.Controls.Add(removableStatus);

            Button removeRow = new Button();
            FixtureIdentity.Assign(removeRow, "remove-row");
            removeRow.Text = "Remove row";
            removeRow.Location = new Point(16, y);
            removeRow.Size = new Size(110, 26);
            removeRow.Click += delegate { removableRow.Visible = false; };
            card.Controls.Add(removeRow);

            Button resetRemovable = new Button();
            FixtureIdentity.Assign(resetRemovable, "reset-removable");
            resetRemovable.Text = "Reset row";
            resetRemovable.Location = new Point(140, y);
            resetRemovable.Size = new Size(80, 26);
            resetRemovable.Click += delegate { removableRow.Visible = true; };
            card.Controls.Add(resetRemovable);
        }
    }
}
