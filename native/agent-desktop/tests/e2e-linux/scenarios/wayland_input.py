from __future__ import annotations

from scenarios.headed_actions import find_ref as qualified_ref

from runner.apps import launch, stop
from runner.legs import implementation
from runner.verdict import LegContext
from oracle import clipboard
from oracle.atspi_raw import app_root, poll
from runner.helper import changed

TEXT_EDITOR = "Text Editor"


def walk(node) -> list:
    nodes = [node]
    for child in node.children():
        nodes.extend(walk(child))
    return nodes


def document_text(root) -> str:
    parts = []
    for node in walk(root):
        text = node.text()
        if text:
            parts.append(text)
    return "\n".join(parts)


def text_ref(tree: dict | None) -> str | None:
    return next((found for role in ("textfield", "textbox", "text", "entry")
                 if (found := qualified_ref(tree, role=role)) is not None), None)


def _editor(ctx: LegContext):
    app = launch(ctx.tier, TEXT_EDITOR)
    root = app_root(ctx.tier, "gnome-text-editor")
    snapshot = ctx.product(["snapshot", "--app", TEXT_EDITOR, "-i"])
    assert snapshot.ok, snapshot.raw
    ref = text_ref((snapshot.data or {}).get("tree"))
    assert ref, "Text Editor exposes no document ref"
    return app, root, ref


def _read(ctx):
    return document_text(app_root(ctx.tier, "gnome-text-editor"))


def _restore(ctx, ref, before):
    assert ctx.product(["clear", ref]).ok
    if before:
        assert ctx.product(["type", ref, before]).ok
    ctx.restored("atspi.document_text", changed(lambda: _read(ctx), before))


def first_key_lands(ctx: LegContext) -> None:
    app, root, ref = _editor(ctx)
    try:
        before = document_text(root)
        ctx.before("atspi.document_text", before)
        envelope = ctx.product(["press", "h", "--window-id", _window_id(ctx)])
        assert envelope.ok, envelope.raw
        after = poll(lambda: _read(ctx) if "h" in _read(ctx) else None, 4)
        ctx.after("atspi.document_text", after)
        assert after is not None, "the first key did not land"
        _restore(ctx, ref, before)
    finally:
        stop(app)


def modifiers_work(ctx: LegContext) -> None:
    app, root, ref = _editor(ctx)
    try:
        assert ctx.product(["type", ref, "abc"]).ok
        before = _read(ctx)
        ctx.before("atspi.document_text", before)
        assert ctx.product(["press", "ctrl+a", "--window-id", _window_id(ctx)]).ok
        assert ctx.product(["type", ref, "z"]).ok
        after = poll(lambda: _read(ctx) if "z" in _read(ctx) and "abc" not in _read(ctx) else None, 4)
        ctx.after("atspi.document_text", after)
        assert after is not None, "modifier selection did not replace the document"
        _restore(ctx, ref, before)
    finally:
        stop(app)


def _window_id(ctx: LegContext) -> str:
    envelope = ctx.product(["list-windows", "--app", TEXT_EDITOR])
    assert envelope.ok and envelope.data, envelope.raw
    return envelope.data[0]["id"]


def _search_present(ctx):
    return any(node.role in (40, 61, 79) and "SHOWING" in node.states and
               any(word in node.name.lower() for word in ("search", "find"))
               for node in walk(app_root(ctx.tier, "gnome-text-editor")))


def ctrl_f_two_keycodes(ctx: LegContext) -> None:
    app, root, _ref = _editor(ctx)
    try:
        before = _search_present(ctx)
        ctx.before("atspi.find_bar", before)
        assert not before, "find bar must start closed"
        envelope = ctx.product(["press", "ctrl+f", "--window-id", _window_id(ctx)])
        assert envelope.ok, envelope.raw
        ctx.after("atspi.find_bar", changed(lambda: _search_present(ctx), True))
        assert ctx.product(["press", "escape", "--window-id", _window_id(ctx)]).ok
        ctx.restored("atspi.find_bar", changed(lambda: _search_present(ctx), before))
    finally:
        stop(app)


def clipboard_paste_into_app(ctx: LegContext) -> None:
    app, root, _ref = _editor(ctx)
    before = document_text(root)
    initial = clipboard.foreign_get(ctx.tier, "text")
    assert initial is None, "private clipboard must start empty"
    ctx.before("clipboard.text", initial)
    ctx.before("atspi.document_text", before)
    owner = clipboard.foreign_set(ctx.tier, "text", b"harness-paste")
    try:
        response = ctx.product(["press", "ctrl+v", "--window-id", _window_id(ctx)])
        assert response.ok, response.raw
        read = lambda: document_text(app_root(ctx.tier, "gnome-text-editor"))
        after = poll(lambda: read() if "harness-paste" in read() else None, 4.0)
        ctx.after("atspi.document_text", after)
        ctx.after("clipboard.text", clipboard.foreign_get(ctx.tier, "text"))
        assert after is not None, "clipboard paste did not reach the document"
        assert ctx.product(["clear", _ref]).ok
        if before:
            assert ctx.product(["type", _ref, before]).ok
        ctx.restored("atspi.document_text", changed(read, before))
    finally:
        clipboard.stop_owner(owner)
        assert ctx.product(["clipboard-clear"]).ok
        ctx.restored("clipboard.text", changed(lambda: clipboard.foreign_get(ctx.tier, "text"), initial))
        stop(app)


def key_before_throwaway_not_rescued(ctx: LegContext) -> None:
    app, root, ref = _editor(ctx)
    try:
        before = document_text(root)
        ctx.before("atspi.document_text", before)
        envelope = ctx.product(["press", "x", "--timeout-ms", "500"])
        after = _read(ctx)
        ctx.after("atspi.document_text", after)
        assert envelope.ok and "x" in after, "the first key did not land; no rescue was attempted"
        _restore(ctx, ref, before)
    finally:
        stop(app)
