from oracle import clipboard as foreign_clipboard, proc, x11
from runner.helper import managed, require, root
from runner.legs import implementation
from scenarios import capture


@implementation("gaps.display_capture")
@implementation("gaps.mutter_display_capture_refused")
def display_capture(ctx):
    with managed(ctx, "Calculator"):
        before = capture._oracle_image(ctx)
        active = x11.active_window(ctx.tier)
        ctx.before("pixels.display_dimensions", (before.width, before.height))
        ctx.before("x11.active_window", active)
        response = ctx.product(["screenshot", "--screen", "0"])
        after = capture._oracle_image(ctx)
        ctx.after("pixels.display_dimensions", (after.width, after.height))
        ctx.after("x11.active_window", x11.active_window(ctx.tier))
        require(x11.active_window(ctx.tier) == active, "capture changed the active window")
        if ctx.tier.name == "x11-mutter":
            error = response.error or {}
            require(not response.ok and error.get("code") == "PLATFORM_NOT_SUPPORTED"
                    and (error.get("details") or {}).get("reason") == "compositing", response.raw)
        else:
            product = capture.decode(*capture.capture_bytes(response))
            capture._matches(product, after)
            require(capture.non_blank(product), "display capture is blank")
        restored = capture._oracle_image(ctx)
        ctx.restored("pixels.display_dimensions", (restored.width, restored.height))
        ctx.restored("x11.active_window", x11.active_window(ctx.tier))


@implementation("gaps.wayland_window_capture_refused")
def wayland_window_capture_refused(ctx):
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        read = lambda: [(node.path, node.name) for node in tree.children()]
        before = read()
        ctx.before("atspi.windows", before)
        response = ctx.product(["screenshot", "--window-id", app.windows[0]])
        error = response.error or {}
        require(not response.ok and error.get("code") == "PLATFORM_NOT_SUPPORTED", response.raw)
        require("single window" in error.get("message", "").lower()
                and "wayland" in error.get("message", "").lower(), response.raw)
        require((error.get("disposition") or {}).get("delivery") == "not_delivered", response.raw)
        after = read()
        ctx.after("atspi.windows", after)
        require(after == before, "capture refusal changed the target")
        ctx.restored("atspi.windows", read())


def clipboard_offers(ctx):
    code, stdout, stderr = foreign_clipboard._run(["wl-paste", "--list-types"], dict(ctx.tier.env))
    require(code in (0, 1), "foreign clipboard reader did not complete")
    if code:
        require(stderr.strip().lower() in (b"no selection", b"nothing is copied"),
                f"foreign clipboard offer state is unobservable: {stderr!r}")
    return stdout.decode().splitlines()


def clipboard_refusal(ctx, argv):
    before = clipboard_offers(ctx)
    require(before == [], "private clipboard must start empty")
    members = proc.members(ctx.tier.runtime_dir)
    ctx.before("clipboard.offers", before)
    ctx.before("proc.clipboard_members", members)
    response = ctx.product(argv)
    error = response.error or {}
    require(not response.ok and error.get("code") == "ACTION_FAILED", response.raw)
    require((error.get("details") or {}).get("reason") == "no_keyboard_seat", response.raw)
    require((error.get("disposition") or {}).get("delivery") == "not_delivered", response.raw)
    after = clipboard_offers(ctx)
    ctx.after("clipboard.offers", after)
    ctx.after("proc.clipboard_members", proc.members(ctx.tier.runtime_dir))
    require(after == before and proc.members(ctx.tier.runtime_dir) == members,
            "a refused clipboard operation left content or a helper owner")
    ctx.restored("clipboard.offers", clipboard_offers(ctx))
    ctx.restored("proc.clipboard_members", proc.members(ctx.tier.runtime_dir))
