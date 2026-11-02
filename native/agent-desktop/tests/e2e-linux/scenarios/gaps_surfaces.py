from dataclasses import replace

from runner.apps import window_id
from oracle import atspi_raw as raw
from runner.helper import changed, managed, ref, require
from runner.legs import implementation
from scenarios.surfaces import (assert_owner, dialog_state, dialogs, dismiss_about, open_about,
                                prepare_about, seeded_wait)


def surface_event(ctx, token, scoped, success):
    with managed(ctx, "Calculator") as app:
        opened = token == "surface-dismissed" if scoped else success
        if opened:
            open_about(ctx, app)
        read = lambda: dialog_state(ctx, app)
        before = read()
        require(len(before) == int(opened), "unexpected raw About baseline")
        ctx.before("atspi.dialogs", before)
        try:
            if not scoped or not success:
                argv = ["wait", "--event", token, "--timeout", "1500"]
                if scoped:
                    argv += ["--app", "Calculator"]
                response = ctx.product(argv)
                error = response.error or {}
                expected = "TIMEOUT" if scoped else "INVALID_ARGS"
                require(not response.ok and error.get("code") == expected, response.raw)
                if not scoped:
                    require((error.get("disposition") or {}).get("delivery") == "not_delivered",
                            response.raw)
                    require(error.get("message") == f"--event {token} requires --app", response.raw)
                else:
                    details = error.get("details") or {}
                    counts = details.get("baseline_counts") or {}
                    require(details.get("event") == token and details.get("kind") == "wait_timeout"
                            and counts.get("apps", 0) > 0 and counts.get("windows", 0) > 0,
                            response.raw)
                    if opened:
                        require(counts.get("surfaces", 0) > 0, response.raw)
                ctx.after("atspi.dialogs", changed(read, before))
            else:
                if opened:
                    dialog = replace(app, windows=[window_id(dialogs(ctx, app)[0])])
                    target = ref(ctx, dialog, name="Close", role="button", surface="sheet")
                else:
                    target = prepare_about(ctx, app)
                event = seeded_wait(ctx, token, target, "sheet")
                assert_owner(event, app)
                expected_count = 0 if opened else 1
                require(raw.poll(
                    lambda: len(read()) == expected_count, 5), "raw dialog did not transition")
                observed = before if opened else read()
                require("About" in observed[0][1], "the opener produced another dialog")
                require(event.get("title") == (observed[0][1] or None),
                        f"surface event title disagrees with raw dialog: {event}")
                ctx.after("atspi.dialogs", read())
        finally:
            if opened and not read():
                open_about(ctx, app)
            elif not opened and read():
                dismiss_about(ctx, app)
            ctx.restored("atspi.dialogs", changed(read, before))
            if read():
                dismiss_about(ctx, app)


for _token in ("surface-appeared", "surface-dismissed"):
    for _scope in ("scoped", "unscoped"):
        for _kind in ("success", "quiet"):
            implementation(f"gaps.event_{_token}_{_scope}_{_kind}")(
                lambda ctx, token=_token, scoped=_scope == "scoped", success=_kind == "success":
                surface_event(ctx, token, scoped, success))
