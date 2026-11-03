using System;
using System.Drawing;
using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Approach item 4: choices.
    /// </summary>
    internal static partial class FixtureCards
    {
        private static void BuildChoices(Form owner, LayoutCursor cursor)
        {
            GroupBox card = CardLayout.AddCard(owner, cursor, "Choices", 200);

            ComboBox optionPicker = new ComboBox();
            FixtureIdentity.Assign(optionPicker, "option-picker");
            optionPicker.DropDownStyle = ComboBoxStyle.DropDownList;
            optionPicker.Items.Add("one");
            optionPicker.Items.Add("two");
            optionPicker.Items.Add("three");
            optionPicker.Location = new Point(16, CardLayout.RowY(0));
            optionPicker.Width = 150;
            card.Controls.Add(optionPicker);
            optionPicker.SelectedIndexChanged += delegate { FixtureStatus.SetValue("picker-status", "changed"); };
            NewStatus(card, "picker-status", 176, CardLayout.RowY(0), 200);

            BuildRadioGroup(card, CardLayout.RowY(1));
            NewStatus(card, "radio-status", 400, CardLayout.RowY(1), 200);

            TabControl tabView = new TabControl();
            FixtureIdentity.Assign(tabView, "tab-view");
            tabView.Location = new Point(16, CardLayout.RowY(2) + 6);
            tabView.Size = new Size(300, 60);
            TabPage tabOne = new TabPage("One");
            FixtureIdentity.Assign(tabOne, "tab-one");
            TabPage tabTwo = new TabPage("Two");
            FixtureIdentity.Assign(tabTwo, "tab-two");
            tabView.TabPages.Add(tabOne);
            tabView.TabPages.Add(tabTwo);
            tabView.SelectedIndexChanged += delegate { FixtureStatus.SetValue("tab-status", "changed"); };
            card.Controls.Add(tabView);
            NewStatus(card, "tab-status", 330, CardLayout.RowY(2) + 6, 200);

            LinkLabel exampleLink = new LinkLabel();
            FixtureIdentity.Assign(exampleLink, "example-link");
            exampleLink.Text = "Example link";
            exampleLink.Location = new Point(16, CardLayout.RowY(4) + 14);
            exampleLink.AutoSize = true;
            card.Controls.Add(exampleLink);
        }

        private static void BuildRadioGroup(GroupBox card, int y)
        {
            RadioButton radioOne = new RadioButton();
            FixtureIdentity.Assign(radioOne, "radio-one");
            radioOne.Text = "One";
            radioOne.Location = new Point(16, y);
            radioOne.Size = new Size(80, 24);
            card.Controls.Add(radioOne);

            RadioButton radioTwo = new RadioButton();
            FixtureIdentity.Assign(radioTwo, "radio-two");
            radioTwo.Text = "Two";
            radioTwo.Location = new Point(100, y);
            radioTwo.Size = new Size(80, 24);
            card.Controls.Add(radioTwo);

            RadioButton radioThree = new RadioButton();
            FixtureIdentity.Assign(radioThree, "radio-three");
            radioThree.Text = "Three";
            radioThree.Location = new Point(184, y);
            radioThree.Size = new Size(80, 24);
            card.Controls.Add(radioThree);

            EventHandler onChanged = delegate { FixtureStatus.SetValue("radio-status", "changed"); };
            radioOne.CheckedChanged += onChanged;
            radioTwo.CheckedChanged += onChanged;
            radioThree.CheckedChanged += onChanged;
        }
    }
}
