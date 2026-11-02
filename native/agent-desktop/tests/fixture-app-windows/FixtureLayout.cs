using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Tracks a running vertical offset so each card is stacked below the
    /// last one, and hands the main form's constructor a final content
    /// height for <see cref="Form.AutoScrollMinSize"/> once every card has
    /// been built.
    /// </summary>
    public sealed class LayoutCursor
    {
        public LayoutCursor(int startY)
        {
            this.Bottom = startY;
        }

        public int Bottom { get; private set; }

        public int Advance(int height)
        {
            int y = this.Bottom;
            this.Bottom = this.Bottom + height + 16;
            return y;
        }
    }

    /// <summary>
    /// Shared card-shell layout so every card in every U5 file positions
    /// itself the same way: a titled <see cref="GroupBox"/> stacked at the
    /// cursor's next offset, wide enough for a two-column actor/readout
    /// layout.
    /// </summary>
    internal static class CardLayout
    {
        internal const int CardWidth = 840;
        internal const int Margin = 20;
        internal const int RowHeight = 34;
        internal const int RowStart = 24;

        internal static GroupBox AddCard(Form owner, LayoutCursor cursor, string title, int height)
        {
            GroupBox box = new GroupBox();
            box.Text = title;
            box.Location = new Point(Margin, cursor.Advance(height));
            box.Size = new Size(CardWidth, height);
            owner.Controls.Add(box);
            return box;
        }

        internal static int RowY(int rowIndex)
        {
            return RowStart + rowIndex * RowHeight;
        }
    }
}
