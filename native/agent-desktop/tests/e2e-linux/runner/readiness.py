import time

from oracle import atspi_raw as raw, proc, x11
from oracle.gsettings import tool
from runner.session import TierUnavailable


def shell_root(tier):
    for node in raw.registry(tier):
        try:
            pid = raw.owner_pid(node)
            _, _, name, env = proc.facts(pid)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if name == "gnome-shell" and env.get("XDG_RUNTIME_DIR") == str(tier.runtime_dir):
            return node
    raise RuntimeError("private shell AT-SPI owner missing")


def close_overview(tier):
    if tier.name == "x11-mutter":
        tool(tier, ["xdotool", "key", "Escape"])
        return
    connection = raw.connect(tier.bus_address)
    service = "org.gnome.Mutter.RemoteDesktop"
    path = raw.call(connection, service, "/org/gnome/Mutter/RemoteDesktop", service, "CreateSession")[0]
    try:
        raw.call(connection, service, path, service + ".Session", "Start")
        for down in (True, False):
            raw.call(connection, service, path, service + ".Session", "NotifyKeyboardKeysym",
                     "(ub)", (0xff1b, down))
    finally:
        raw.call(connection, service, path, service + ".Session", "Stop")


def probe(tier, app):
    if tier.name in ("x11-mutter", "wayland"):
        active = x11.overview_active(tier)
        if type(active) is not bool:
            raise RuntimeError("Overview state is unknown")
        if active:
            close_overview(tier)
            raise RuntimeError("Overview has not closed yet")
        shell = shell_root(tier)
        if not shell.name:
            raise RuntimeError("shell AT-SPI name missing")
        shell.children()
    else:
        if "window id" not in tool(tier, ["xprop", "-root", "_NET_SUPPORTING_WM_CHECK"]):
            raise RuntimeError("X11 window manager is unavailable")
        raw.registry(tier)
    if app is not None:
        node = raw.app_root(tier, app.owner_names[0])
        if not node.children():
            raise RuntimeError(f"{app.name} AT-SPI frame missing after mapping")


def wait_ready(tier, app=None, *, seconds=45.0):
    deadline = time.monotonic() + seconds
    last = "no responsiveness sample"
    while True:
        try:
            with raw.bounded_until(deadline):
                probe(tier, app)
            if time.monotonic() >= deadline:
                raise TimeoutError("responsiveness sample completed after its deadline")
            return
        except Exception as error:
            last = f"{type(error).__name__}: {error}"
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TierUnavailable(f"{tier.name}: WM/AT-SPI responsiveness gate expired: {last}")
        time.sleep(min(0.1, remaining))
