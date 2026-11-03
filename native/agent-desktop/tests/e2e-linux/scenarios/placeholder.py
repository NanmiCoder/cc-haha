from contextlib import nullcontext

from oracle.atspi_raw import ACCESSIBLE, RawNode
from runner.helper import changed, command, managed, nodes, require, root
from runner.legs import implementation
from runner.verdict import LegContext
from scenarios.ref_effects import desktop_restored

COMPONENT = "org.a11y.atspi.Component"
EDITABLE_TEXT = "org.a11y.atspi.EditableText"


def internal_editor(field):
    x, y, width, height = field.invoke(COMPONENT, "GetExtents", "(u)", (2,))[0]
    require(width > 0 and height > 0, "search field has no hit area")
    bus, path = field.invoke(COMPONENT, "GetAccessibleAtPoint", "(iiu)",
                             (x + width // 2, y + height // 2, 2))[0]
    candidate = RawNode(field.connection, bus or field.bus, path)
    for _ in range(2):
        require(candidate.bus == field.bus, "search hit belongs to another application")
        parent_bus, parent_path = candidate.get_property(ACCESSIBLE, "Parent")
        if (parent_bus or field.bus, parent_path) == (field.bus, field.path):
            require(EDITABLE_TEXT in candidate.interfaces(), "search hit is not an editor")
            return candidate
        candidate = RawNode(field.connection, parent_bus or field.bus, parent_path)
    raise AssertionError("search editor is not owned by the exact search field")


def type_search_query(ctx, app):
    fields = [node for node in root(ctx, app).walk()
              if node.role in (61, 79) and "SHOWING" in node.states]
    require(len(fields) == 1, "one visible search textfield required")
    field = fields[0]
    require("FOCUSED" not in field.states, "fixture no longer exposes composite focus")
    require(field.invoke(ACCESSIBLE, "GetState")[0][0] & (1 << 7),
            "search wrapper is not editable")
    editor = internal_editor(field)
    changed(lambda: "FOCUSED" in editor.states, True)
    before = editor.text()
    require(before == "", "search query is not initially empty")
    ctx.before("atspi.search_query", before)
    listing = command(ctx, ["snapshot", "-i"], app).data
    targets = [node["ref_id"] for node in nodes(listing.get("tree"))
               if node.get("role") == "textfield" and node.get("ref_id")]
    require(len(targets) == 1, "one product search ref required")
    try:
        command(ctx, ["type", targets[0], "gateprobe"])
        ctx.after("atspi.search_query", changed(editor.text, "gateprobe"))
        require("FOCUSED" in editor.states, "typed search editor is not focused")
    finally:
        require(editor.invoke(EDITABLE_TEXT, "SetTextContents", "(s)", (before,))[0],
                "search query restoration was refused")
        ctx.restored("atspi.search_query", changed(editor.text, before))


def placeholder_read(ctx, app, expected):
    fields = [node for node in root(ctx, app).walk() if node.role in (61, 79)
              and "SHOWING" in node.states]
    require(fields, "search field is absent")
    evidence = [(node.name, node.get_property(ACCESSIBLE, "Description"), node.attributes())
                for node in fields]
    if expected:
        require(any(attrs.get("placeholder-text", attrs.get("placeholder")) == expected
                    for _, _, attrs in evidence), "raw placeholder disagrees")
    else:
        require(all(not attrs.get("placeholder-text", attrs.get("placeholder"))
                    for _, _, attrs in evidence))
    ctx.before("atspi", evidence)
    data = command(ctx, ["snapshot", "-i"], app).data
    candidates = [item for item in nodes(data.get("tree")) if item.get("role") == "textfield"]
    require(candidates, "search field omitted from product snapshot")
    if expected:
        selected = [item for item in candidates if item.get("placeholder") == expected]
        require(len(selected) == 1 and not selected[0].get("description"))
    else:
        require(all(not item.get("placeholder") for item in candidates))
    after = [(node.name, node.get_property(ACCESSIBLE, "Description"), node.attributes())
             for node in fields]
    require(after == evidence)
    ctx.after("atspi", after)
    ctx.restored("atspi", [(node.name, node.get_property(ACCESSIBLE, "Description"), node.attributes())
                           for node in fields])


@implementation("placeholder.settings_apps_search")
def settings_apps_search(ctx: LegContext) -> None:
    with managed(ctx, "Settings", ("applications",)) as app:
        placeholder_read(ctx, app, "Search apps")


@implementation("placeholder.files_search_none")
def files_search_none(ctx: LegContext) -> None:
    with managed(ctx, "Files", (str(ctx.tier.runtime_dir),)) as app, \
            (desktop_restored(ctx) if ctx.mode == "headed" else nullcontext()):
        tree = root(ctx, app)
        switches = tree.find(role=62, name="Search Current Folder")
        require(len(switches) == 1)
        from runner.helper import activate, changed
        activate(switches[0])
        changed(lambda: "PRESSED" in switches[0].states, True)
        try:
            placeholder_read(ctx, app, None)
            if ctx.mode == "headed":
                type_search_query(ctx, app)
        finally:
            activate(switches[0])
            changed(lambda: "PRESSED" in switches[0].states, False)
