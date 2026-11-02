from oracle.atspi_raw import poll
from runner.helper import changed, command, delayed, one, ref, require, root, remove
from runner.legs import implementation
from scenarios import toolkit_qt
from scenarios.ref_effects import desktop_restored


def delayed_dispatch(ctx, target, read, enable):
    before = read()
    require(before == (False, 0), "controlled target must start disabled and unactivated")
    ctx.before("atspi.delayed_target", before[0])
    trigger = delayed(0.4, enable)
    try:
        command(ctx, ["click", target, "--timeout-ms", "3000"])
        trigger.join()
        changed(read, (True, 1))
        ctx.after("atspi.delayed_target", read()[0])
        require(read() == (True, 1), "delayed action did not dispatch exactly once")
    finally:
        trigger.cancel()


@implementation("gaps.delayed_enable")
def delayed_enable(ctx):
    with toolkit_qt.qt_app(ctx) as app, desktop_restored(ctx):
        tree = root(ctx, app)
        button = one(tree, role=43, name="Delayed activation")
        target = ref(ctx, app, role="button", name="Delayed activation")
        log = ctx.tier.runtime_dir / "qt-window.log"
        read = lambda: ("SENSITIVE" in button.states,
                        toolkit_qt.events(log).count("delayed-click"))
        try:
            delayed_dispatch(ctx, target, read, lambda: log.with_suffix(".enable").touch())
            ctx.after("applog", toolkit_qt.log_state(ctx))
        finally:
            log.with_suffix(".reset").touch()
            require(poll(lambda: "SENSITIVE" not in button.states, 3), "delayed target did not reset")
            records = toolkit_qt.events(log)
            require(records.count("delayed-click") == 1, "activation count changed after dispatch")
            ctx.restored("atspi.delayed_target", "SENSITIVE" in button.states)
            for suffix in (".enable", ".enable-consumed", ".reset", ".reset-consumed"):
                remove(log.with_suffix(suffix))


@implementation("gaps.timeout_default")
def default_timeout(ctx):
    from scenarios.gaps_actions import disabled_timeout
    disabled_timeout(ctx, None)


@implementation("wayland_actions.headed_ref_refusal")
def headed_ref_refusal(ctx):
    from runner.helper import display, managed
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        target = ref(ctx, app, role="button", name="7")
        read = lambda: display(tree)
        before = read()
        ctx.before("atspi.display", before)
        response = ctx.product(["click", target])
        error = response.error or {}
        require(not response.ok and error.get("code") == "ACTION_NOT_SUPPORTED", response.raw)
        require((error.get("details") or {}).get("cause") == "wayland_session", response.raw)
        require((error.get("disposition") or {}).get("delivery") == "not_delivered", response.raw)
        ctx.after("atspi.display", read())
        require(read() == before, "refused headed action changed Calculator")
        ctx.restored("atspi.display", read())


@implementation("wayland_actions.semantic_click_without_seat")
def semantic_click_without_seat(ctx):
    from runner.helper import activate, display, managed
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        target = ref(ctx, app, role="button", name="7")
        read = lambda: display(tree)
        before = read()
        require(before in ("", "0"), "Calculator must start empty")
        ctx.before("atspi.display", before)
        try:
            command(ctx, ["click", target], app)
            ctx.after("atspi.display", changed(read, "7"))
        finally:
            if read() != before:
                activate(one(tree, role=43, name="Undo"))
            ctx.restored("atspi.display", changed(read, before))
