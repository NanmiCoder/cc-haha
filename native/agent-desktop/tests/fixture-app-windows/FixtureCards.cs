using System.Windows.Forms;

namespace AgentDeskFixtureApp
{
    /// <summary>
    /// Every resident target the plan's approach items 1-4, 5's
    /// non-provider members, 6, 9 and 12 describe, built eagerly into the
    /// main form so every id is present in the identity manifest
    /// (<c>AgentDeskFixture.ids.txt</c>) the moment <c>Main</c> writes it.
    ///
    /// Split across <c>FixtureCards*.cs</c> as one <c>partial</c> class - one
    /// file per approach item group, plus a shared helpers file - so each
    /// stays under the repository's per-file line cap; this file keeps only
    /// the top-level dispatcher.
    /// </summary>
    internal static partial class FixtureCards
    {
        internal static void Build(Form owner, LayoutCursor cursor)
        {
            BuildClicksAndMouse(owner, cursor);
            BuildTextInput(owner, cursor);
            BuildStateControls(owner, cursor);
            BuildChoices(owner, cursor);
            BuildCollectionsAndDisclosure(owner, cursor);
            BuildScroll(owner, cursor);
            BuildZeroBounds(owner, cursor);
            BuildSurfaces(owner, cursor);
        }
    }
}
