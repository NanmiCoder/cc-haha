using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Card-building helpers shared across every <c>FixtureCards*.cs</c>
    /// partial-class file.
    /// </summary>
    internal static partial class FixtureCards
    {
        private static Button NewButton(GroupBox card, string id, string text, int x, int y, int width)
        {
            Button button = new Button();
            FixtureIdentity.Assign(button, id);
            button.Text = text;
            button.Location = new Point(x, y);
            button.Size = new Size(width, 26);
            card.Controls.Add(button);
            return button;
        }

        private static TextBox NewStatus(GroupBox card, string id, int x, int y, int width)
        {
            TextBox status = FixtureStatus.Create(id);
            status.Location = new Point(x, y);
            status.Width = width;
            card.Controls.Add(status);
            return status;
        }
    }
}
