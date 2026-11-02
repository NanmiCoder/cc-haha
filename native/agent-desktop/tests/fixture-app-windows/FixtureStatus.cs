using System;
using System.Collections.Generic;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// A live status readout: a read-only <see cref="TextBox"/> whose
    /// AutomationId is its identity and whose ValuePattern-backed .Text is
    /// its live value. Identity and value are separate slots on purpose - a
    /// UIA client that reads "value" can never be confused with one that
    /// reads "name", which is the discrimination the harness's status leg
    /// relies on.
    /// </summary>
    public sealed class FixtureStatus
    {
        private const string SentinelValue = "idle";

        private static readonly Dictionary<string, FixtureStatus> Registry =
            new Dictionary<string, FixtureStatus>();

        private readonly TextBox textBox;
        private int invocationCounter;

        private FixtureStatus(TextBox textBox)
        {
            this.textBox = textBox;
        }

        /// <summary>
        /// Builds a status readout, assigns its AutomationId through the
        /// shared identity helper and registers it so any card can address
        /// it later purely by id.
        /// </summary>
        public static TextBox Create(string automationId)
        {
            TextBox textBox = new TextBox();
            textBox.ReadOnly = true;
            textBox.TabStop = false;
            textBox.Text = SentinelValue;
            textBox.AccessibleName = automationId + "-readout";
            FixtureIdentity.Assign(textBox, automationId);

            FixtureStatus status = new FixtureStatus(textBox);
            Registry[automationId] = status;
            return textBox;
        }

        /// <summary>
        /// Writes a new live value to a previously created status readout,
        /// looked up purely by id so any card can drive any status without
        /// holding a reference to its control. Every write appends a
        /// monotonically increasing per-status counter to the assigned
        /// value, so no two writes to the same status ever produce the same
        /// text and a leg can never pass on a value an earlier leg left
        /// behind.
        /// </summary>
        public static void SetValue(string automationId, string value)
        {
            FixtureStatus status;
            if (!Registry.TryGetValue(automationId, out status))
            {
                throw new KeyNotFoundException(
                    "no status readout registered for id: " + automationId);
            }
            status.invocationCounter = status.invocationCounter + 1;
            status.textBox.Text = value + "#" + status.invocationCounter.ToString();
        }

        /// <summary>
        /// Resets a status readout's displayed text back to the startup
        /// sentinel, for cards that offer an explicit reset control. The
        /// invocation counter is deliberately never zeroed here: zeroing it
        /// would let a later write reproduce an earlier leg's exact
        /// expected text (for example "clicked#1" after a reset), which is
        /// precisely the stale-value collision the counter exists to rule
        /// out. Every write for the lifetime of the process gets a value no
        /// earlier write could have produced.
        /// </summary>
        public static void Reset(string automationId)
        {
            FixtureStatus status;
            if (!Registry.TryGetValue(automationId, out status))
            {
                throw new KeyNotFoundException(
                    "no status readout registered for id: " + automationId);
            }
            status.textBox.Text = SentinelValue;
        }
    }
}
