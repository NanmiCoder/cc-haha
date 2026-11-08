from oracle import gsettings, x11
from runner.helper import changed, display, managed, one, ref, require, root
from runner.legs import implementation


def disabled_timeout(ctx, timeout):
    with managed(ctx, "Calculator") as app:
        tree = root(ctx, app)
        undo = one(tree, role=43, name="Undo")
        target = ref(ctx, app, role="button", name="Undo")
        read = lambda: ("SENSITIVE" in undo.states, display(tree))
        before = read()
        require(before[0] is False, "Undo must start disabled")
        ctx.before("atspi.disabled_action", before)
        argv = ["click", target]
        if timeout is not None:
            argv += ["--timeout-ms", str(timeout)]
        response = ctx.product(argv)
        error = response.error or {}
        if timeout == 0:
            require(not response.ok and error.get("code") == "ACTION_FAILED", response.raw)
            checks = (error.get("details") or {}).get("checks") or []
            require(any(check.get("check") == "enabled" and check.get("status") == "fail"
                        for check in checks), "zero-timeout refusal did not check the disabled target")
            require((error.get("disposition") or {}).get("delivery") == "not_delivered", response.raw)
        else:
            require(not response.ok and error.get("code") == "TIMEOUT", response.raw)
            require((error.get("details") or {}).get("kind") == "actionability_timeout",
                    response.raw)
        expected = 5000 if timeout is None else timeout
        require(max(0, expected - 500) <= response.elapsed_ms <= expected + 2000,
                f"timeout {timeout!r} took {response.elapsed_ms}ms, expected {expected}ms")
        after = read()
        ctx.after("atspi.disabled_action", after)
        require(after == before, "a disabled action changed the Calculator")
        ctx.restored("atspi.disabled_action", read())


for _name, _timeout in (("explicit", 2000), ("short", 100), ("zero", 0)):
    implementation(f"gaps.timeout_{_name}")(
        lambda ctx, timeout=_timeout: disabled_timeout(ctx, timeout))


@implementation("gaps.value_write_preserves_active_window")
def value_write_preserves_active_window(ctx):
    schema, key = "org.gnome.desktop.peripherals.mouse", "speed"
    with managed(ctx, "Settings", ("mouse",)) as settings:
        target = ref(ctx, settings, role="slider", name="Pointer Speed")
        with managed(ctx, "Text Editor") as other:
            native = x11.xid(ctx.tier, other.windows[0])
            x11.restore_active(ctx.tier, native)
            before = gsettings.get(ctx.tier, schema, key)
            pointer, active = x11.pointer(ctx.tier), x11.active_window(ctx.tier)
            require(active == native, "the value-write target must be in the background")
            ctx.before("gsettings.speed", before)
            ctx.before("x11.active_window", active)
            ctx.before("x11.pointer", pointer)
            try:
                value = "0.2" if float(before) != 0.2 else "0.4"
                response = ctx.product(["set-value", target, value])
                require(response.ok, response.raw)
                observed = changed(lambda: float(gsettings.get(ctx.tier, schema, key)), float(value))
                ctx.after("gsettings.speed", str(observed))
                ctx.after("x11.active_window", x11.active_window(ctx.tier))
                ctx.after("x11.pointer", x11.pointer(ctx.tier))
                require(x11.active_window(ctx.tier) == active, "value write stole focus")
                require(x11.pointer(ctx.tier) == pointer, "value write moved the pointer")
            finally:
                gsettings.set(ctx.tier, schema, key, before)
                ctx.restored("gsettings.speed", changed(
                    lambda: gsettings.get(ctx.tier, schema, key), before))
                ctx.restored("x11.active_window", x11.restore_active(ctx.tier, active))
                require(x11.pointer(ctx.tier) == pointer, "pointer was not preserved")
                ctx.restored("x11.pointer", x11.pointer(ctx.tier))
