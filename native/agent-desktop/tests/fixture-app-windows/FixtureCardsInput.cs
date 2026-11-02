using System.Drawing;
using System.Windows.Automation;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach item 2 (text input) and item 3 (state controls).
    /// </summary>
    internal static partial class FixtureCards
    {
        private static void BuildTextInput(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Text input", 130);

            TextBox textInput = new TextBox();
            FixtureIdentity.Assign(textInput, "text-input");
            textInput.Location = new Point(16, CardLayout.RowY(0));
            textInput.Width = 200;
            textInput.KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.Control && e.KeyCode == Keys.A)
                {
                    textInput.SelectAll();
                    e.SuppressKeyPress = true;
                }
            };
            card.Controls.Add(textInput);
            textInput.TextChanged += delegate { FixtureStatus.SetValue("text-status", "changed"); };
            NewStatus(card, "text-status", 226, CardLayout.RowY(0), 200);

            TextBox secureInput = new TextBox();
            FixtureIdentity.Assign(secureInput, "secure-input");
            secureInput.UseSystemPasswordChar = true;
            secureInput.Location = new Point(16, CardLayout.RowY(1));
            secureInput.Width = 200;
            card.Controls.Add(secureInput);

            TextBox multilineInput = new TextBox();
            FixtureIdentity.Assign(multilineInput, "multiline-input");
            multilineInput.Multiline = true;
            multilineInput.Location = new Point(16, CardLayout.RowY(2));
            multilineInput.Size = new Size(400, 50);
            card.Controls.Add(multilineInput);
        }

        private static void BuildStateControls(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "State controls", 160);

            CheckBox toggleBox = new CheckBox();
            FixtureIdentity.Assign(toggleBox, "toggle-box");
            toggleBox.Text = "Toggle";
            toggleBox.Location = new Point(16, CardLayout.RowY(0));
            toggleBox.Size = new Size(110, 26);
            card.Controls.Add(toggleBox);
            toggleBox.CheckedChanged += delegate
            {
                FixtureStatus.SetValue("toggle-status", toggleBox.Checked ? "checked" : "unchecked");
            };
            NewStatus(card, "toggle-status", 140, CardLayout.RowY(0), 200);

            Button switchButton = NewButton(card, "switch-button", "Switch", 16, CardLayout.RowY(1), 110);
            ToggleButtonHost switchHost = new ToggleButtonHost(switchButton, "switch-button");
            switchHost.Hook(switchButton);
            switchHost.Toggled += delegate
            {
                switchButton.Text = (switchHost.CurrentState == ToggleState.On) ? "Switch: on" : "Switch: off";
            };
            switchButton.Click += delegate { switchHost.ToggleNow(); };

            TrackBar valueSlider = new TrackBar();
            FixtureIdentity.Assign(valueSlider, "value-slider");
            valueSlider.Minimum = 0;
            valueSlider.Maximum = 10;
            valueSlider.Location = new Point(140, CardLayout.RowY(1));
            valueSlider.Width = 200;
            card.Controls.Add(valueSlider);
            valueSlider.ValueChanged += delegate { FixtureStatus.SetValue("slider-status", "changed"); };
            NewStatus(card, "slider-status", 350, CardLayout.RowY(1), 160);

            BuildValueStepper(card, CardLayout.RowY(2));
        }

        /// <summary>
        /// No probe had measured whether <c>NumericUpDown</c> presents
        /// <c>ControlType.Spinner</c> before this fixture was read back
        /// live. It does: the up-down pair's UIA-visible child carries
        /// <c>ControlType.Spinner</c> (role <c>incrementor</c>) even though
        /// the composite control's own root reads as <c>ComboBox</c>, which
        /// satisfies R4's role-coverage requirement without a
        /// provider-based fallback.
        /// </summary>
        private static void BuildValueStepper(GroupBox card, int y)
        {
            NumericUpDown stepper = new NumericUpDown();
            FixtureIdentity.Assign(stepper, "value-stepper");
            stepper.Minimum = 0;
            stepper.Maximum = 100;
            stepper.Location = new Point(16, y);
            stepper.Width = 100;
            card.Controls.Add(stepper);
            stepper.ValueChanged += delegate { FixtureStatus.SetValue("stepper-status", "changed"); };
            NewStatus(card, "stepper-status", 140, y, 200);
        }
    }
}
