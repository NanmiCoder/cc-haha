using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// The modal dialog <c>open-sheet</c> shows. Built once and reused for
    /// the lifetime of the process: <see cref="Form.ShowDialog(IWin32Window)"/>
    /// does not dispose the form on <see cref="Form.Close"/>, so no
    /// cancel-close/hide trick is needed the way the duplicate-title windows
    /// and the occlusion overlay (shown non-modally via <c>Show</c>) require.
    /// </summary>
    internal sealed class FixtureSheet : Form
    {
        internal FixtureSheet()
        {
            this.Text = "Sheet";
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.StartPosition = FormStartPosition.CenterParent;
            this.ClientSize = new Size(320, 160);
            this.MinimizeBox = false;
            this.MaximizeBox = false;

            Label title = new Label();
            FixtureIdentity.Assign(title, "sheet-title");
            title.Text = "Sheet dialog";
            title.Location = new Point(16, 16);
            title.AutoSize = true;
            this.Controls.Add(title);

            TextBox field = new TextBox();
            FixtureIdentity.Assign(field, "sheet-field");
            field.Location = new Point(16, 44);
            field.Width = 260;
            this.Controls.Add(field);

            Button confirm = new Button();
            FixtureIdentity.Assign(confirm, "confirm-sheet");
            confirm.Text = "Confirm";
            confirm.Location = new Point(16, 90);
            confirm.Size = new Size(110, 28);
            confirm.Click += delegate
            {
                FixtureStatus.SetValue("sheet-status", "confirmed");
                this.Close();
            };
            this.Controls.Add(confirm);

            Button cancel = new Button();
            FixtureIdentity.Assign(cancel, "cancel-sheet");
            cancel.Text = "Cancel";
            cancel.Location = new Point(140, 90);
            cancel.Size = new Size(110, 28);
            cancel.Click += delegate
            {
                FixtureStatus.SetValue("sheet-status", "cancelled");
                this.Close();
            };
            this.Controls.Add(cancel);
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }
    }
}
