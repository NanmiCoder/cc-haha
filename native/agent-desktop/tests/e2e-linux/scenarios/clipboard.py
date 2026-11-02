from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

from oracle import clipboard as oracle_clipboard, pixels
from runner.helper import changed, require
from runner.legs import implementation
from runner.verdict import LegContext

TEXT_FORMAT = "text/plain"


def text_of(data: dict) -> str | None:
    return (data.get("text") or "") if data.get("type") == "text" else None


def stop_owner(pid: int) -> None:
    oracle_clipboard.stop_owner(pid)


def _set_text(ctx, text):
    response = ctx.product(["clipboard-set", text])
    require(response.ok, f"clipboard-set failed: {response.error}")


def _clear(ctx):
    response = ctx.product(["clipboard-clear"])
    require(response.ok, f"clipboard-clear failed: {response.error}")


def _get(ctx, fmt="text"):
    response = ctx.product(["clipboard-get", "--format", fmt])
    require(response.ok, f"clipboard-get failed: {response.error}")
    return response.data or {}


@contextmanager
def _selection(ctx, fmt):
    read = lambda: oracle_clipboard.foreign_get(ctx.tier, fmt)
    initial = read()
    require(initial is None, "private clipboard was not empty at the leg baseline")
    ctx.before("clipboard.selection", initial)
    owners = []
    try:
        yield owners
    finally:
        ctx.after("clipboard.selection", read())
        try:
            _clear(ctx)
        finally:
            for pid in owners:
                stop_owner(pid)
        ctx.restored("clipboard.selection", changed(read, initial))


@implementation("clipboard.text_roundtrip")
def text_roundtrip(ctx: LegContext) -> None:
    with _selection(ctx, TEXT_FORMAT) as owners:
        _set_text(ctx, "product text")
        require(oracle_clipboard.foreign_get(ctx.tier, TEXT_FORMAT) == b"product text",
                "a foreign reader did not see the product's text")
        require(text_of(_get(ctx)) == "product text")
        owners.append(oracle_clipboard.foreign_set(ctx.tier, TEXT_FORMAT, b"foreign text"))
        require(oracle_clipboard.foreign_get(ctx.tier, TEXT_FORMAT) == b"foreign text")
        require(text_of(_get(ctx)) == "foreign text", "the product did not read foreign text")


def _small_image():
    return pixels.Image(2, 2, bytes((255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255)))


def _write_png(ctx, payload):
    path = ctx.tier.runtime_dir / "clipboard-product.png"
    path.write_bytes(payload)
    return path


@implementation("clipboard.image_roundtrip")
def image_roundtrip(ctx: LegContext) -> None:
    image = _small_image()
    payload = pixels.encode_png(image)
    with _selection(ctx, "image/png") as owners:
        owners.append(oracle_clipboard.foreign_set(ctx.tier, "image/png", payload))
        data = _get(ctx, "image")
        require(data.get("path"), "the product did not read the foreign image")
        read_image = pixels.decode_png(Path(data["path"]).read_bytes())
        require(pixels.similar(read_image, image, tolerance=0.0), "foreign image pixels differ")
        response = ctx.product(["clipboard-set", "--image", str(_write_png(ctx, payload))])
        require(response.ok, f"clipboard-set --image failed: {response.error}")
        foreign = oracle_clipboard.foreign_get(ctx.tier, "image/png")
        require(foreign, "a foreign reader saw no product image")
        require(pixels.similar(pixels.decode_png(foreign), image, tolerance=0.0))


def _text_after_exit(ctx, text):
    with _selection(ctx, TEXT_FORMAT):
        _set_text(ctx, text)
        require(oracle_clipboard.foreign_get(ctx.tier, TEXT_FORMAT) == text.encode(),
                "the selection owner did not outlive the setter")


@implementation("clipboard.owner_outlives_setter")
def owner_outlives_setter(ctx: LegContext) -> None:
    _text_after_exit(ctx, "survives the setter")


@implementation("clipboard.clear_leaves_empty")
def clear_leaves_empty(ctx: LegContext) -> None:
    with _selection(ctx, TEXT_FORMAT):
        read = lambda: oracle_clipboard.foreign_get(ctx.tier, TEXT_FORMAT)
        _set_text(ctx, "to be cleared")
        before = changed(read, b"to be cleared")
        ctx.before("clipboard.clear", before)
        _clear(ctx)
        ctx.after("clipboard.clear", changed(read, None))
        _set_text(ctx, "to be cleared")
        ctx.restored("clipboard.clear", changed(read, before))
