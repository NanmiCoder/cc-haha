from __future__ import annotations

import os
import re
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from oracle import atspi_raw as raw, proc, x11
from oracle.gsettings import tool
from runner.session import Tier


@dataclass
class OwnedApp:
    name: str
    pid: int
    start_time: int
    owner_names: list[str]
    windows: list[str]
    display: str


COMMANDS = {
    "Calculator": "gnome-calculator", "Files": "nautilus", "Terminal": "gnome-terminal",
    "Text Editor": "gnome-text-editor", "Settings": "gnome-control-center",
}
ALIASES = {
    "Calculator": ("calculator",), "Files": ("nautilus", "files"),
    "Terminal": ("terminal",), "Text Editor": ("text-editor", "text editor"),
    "Settings": ("control-center", "settings"),
    "Zoo GTK3": ("zoo gtk3", "zoo_gtk3.py"),
    "Zoo GTK4": ("zoo gtk4", "zoo_gtk4.py"),
    "Zoo Qt": ("zoo qt", "zoo_qt.py"),
}
ZOOS = {"Zoo GTK3": "zoo_gtk3", "Zoo GTK4": "zoo_gtk4", "Zoo Qt": "zoo_qt"}
_TIERS = {}
_SPAWNED = {}
SHELL_HELPERS = frozenset({"gnome-shell", "mutter-x11-fram", "mutter-x11-frames"})


def window_id(node) -> str:
    if not re.fullmatch(r":\d+\.\d+", node.bus):
        raise ValueError("window must have a unique accessibility bus owner")
    if not re.fullmatch(r"/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+", node.path):
        raise ValueError("invalid accessibility object path")
    return "w-" + node.bus[1:] + "-" + node.path[1:].replace("/", "-")


def attributable(tier, pid, start, env) -> bool:
    return (pid > 1 and start > 0 and
            env.get("XDG_RUNTIME_DIR") == str(tier.runtime_dir))


def _owners(tier: Tier, *, names: tuple[str, ...] | None = None) -> list[OwnedApp]:
    result = []
    for node in raw.registry(tier):
        try:
            pid = raw.owner_pid(node)
            start, _, process_name, env = proc.facts(pid)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        except Exception as error:
            if "org.freedesktop.DBus.Error.NameHasNoOwner" in str(error):
                continue
            raise
        if not attributable(tier, pid, start, env):
            continue
        if process_name in SHELL_HELPERS:
            continue
        try:
            name = node.name
        except Exception as error:
            commands = tuple(COMMANDS[key] for key, aliases in ALIASES.items() if aliases == names)
            if (names is not None and raw.unresponsive(error)
                    and not proc.may_match(pid, process_name, commands or names)):
                continue
            raise
        if names is not None and not any(needle in name.casefold() for needle in names):
            continue
        frames = [child for child in node.children()
                  if "org.a11y.atspi.Component" in child.interfaces()]
        result.append(OwnedApp(name, pid, start, [node.bus],
                               [window_id(frame) for frame in frames], env.get("DISPLAY", "")))
    return result


def owners_named(tier: Tier, name: str) -> list[OwnedApp]:
    needles = ALIASES.get(name, (Path(name).name.casefold(),))
    result = {}
    for app in _owners(tier, names=needles):
        if any(needle in app.name.casefold() for needle in needles):
            key = app.pid, app.start_time
            if key in result:
                result[key].owner_names.extend(app.owner_names)
                result[key].windows.extend(app.windows)
            else:
                result[key] = app
    return list(result.values())


def _display_verified(tier, app) -> bool:
    if not tier.display:
        return True
    if app.display != tier.display:
        raise AssertionError(f"{app.name} mapped on {app.display}, expected {tier.display}")
    mapped = []
    for xid in x11.stacking_xids(tier):
        text = tool(tier, ["xprop", "-id", xid, "_NET_WM_PID"])
        match = re.search(r"=\s*(\d+)", text)
        if match and int(match[1]) == app.pid:
            x11.geometry(tier, xid)
            mapped.append(xid)
    return len(mapped) >= len(app.windows)


def launch(tier: Tier, app: str, args: tuple[str, ...] = (), *, settle_s: float = 5.0) -> OwnedApp:
    from runner.readiness import wait_ready

    names = ALIASES.get(app, (Path(app).name.casefold(),))
    with raw.bounded_until(time.monotonic() + settle_s):
        before = {(item.pid, item.start_time): set(item.windows) for item in _owners(tier, names=names)}
    env = dict(tier.env)
    # Let toolkits discover accessibility through the owned session bus.
    env.pop("AT_SPI_BUS_ADDRESS", None)
    if app in ZOOS:
        slug = ZOOS[app]
        app = str(Path(__file__).resolve().parents[1] / "apps" / (slug + ".py"))
        event_log = Path(args[0]) if args else tier.runtime_dir / (slug.replace("_", "-") + ".log")
        if event_log.exists():
            event_log.unlink()
        args = args or (str(event_log),)
    if app.endswith(("qt_window.py", "zoo_qt.py")):
        command = [os.environ.get("AGENT_DESKTOP_QT_PYTHON", "python3"), app]
        env.update(QT_ACCESSIBILITY="1", QT_LINUX_ACCESSIBILITY_ALWAYS_ON="1",
                   QT_QPA_PLATFORM="wayland" if tier.name == "wayland" else "xcb")
    elif app.endswith(("zoo_gtk3.py", "zoo_gtk4.py")):
        command = ["python3", app]
        env["GTK_USE_PORTAL"] = "0"
    else:
        command = [COMMANDS.get(app, app)]
    if "code" in Path(command[0]).name:
        env["ACCESSIBILITY_ENABLED"] = "1"
    log = tier.runtime_dir / "app-launch.log"
    with log.open("ab") as stream:
        child = subprocess.Popen(command + list(args), env=env, stdout=stream, stderr=stream,
                                 start_new_session=True)
    _SPAWNED[child.pid] = child

    def locate():
        candidates = [item for item in _owners(tier, names=names) if item.windows and
                      set(item.windows) - before.get((item.pid, item.start_time), set())]
        if len(candidates) > 1:
            raise AssertionError(f"launch attributed multiple owners: {candidates}")
        if candidates and _display_verified(tier, candidates[0]):
            return candidates[0]
        return None

    deadline = time.monotonic() + settle_s
    with raw.bounded_until(deadline):
        found = raw.poll(locate, settle_s)
    if not found:
        raise AssertionError(f"no new private window for {app}; launcher exit={child.poll()}; log={log}")
    _TIERS[found.pid, found.start_time] = tier
    try:
        if time.monotonic() >= deadline:
            from runner.session import TierUnavailable
            raise TierUnavailable(f"{tier.name}: app mapping responsiveness deadline expired")
        wait_ready(tier, found)
    except Exception:
        stop(found)
        raise
    return found


def stop(app: OwnedApp) -> None:
    tier = _TIERS.get((app.pid, app.start_time))
    if tier is None:
        raise ValueError("refusing to stop an unattributed process")

    def alive():
        stat = ""
        try:
            stat = (Path("/proc") / str(app.pid) / "stat").read_text()
            if stat[stat.rindex(")") + 2:].split()[0] == "Z":
                return False
            start, group, _, env = proc.facts(app.pid)
        except (FileNotFoundError, ProcessLookupError):
            return False
        except PermissionError:
            # An exiting process can revoke environ before it becomes a zombie.
            # Attribution was established at launch; retain only that generation.
            if not stat:
                raise
            start, group, _ = proc.stat_fields(stat)
            return group if start == app.start_time else False
        if start != app.start_time:
            return False
        if not attributable(tier, app.pid, start, env):
            child = _SPAWNED.get(app.pid)
            if not env and child is not None:
                try:
                    child.wait(timeout=2.0)
                    return False
                except subprocess.TimeoutExpired:
                    pass
            raise AssertionError("owned process left its runtime directory")
        return group

    group = alive()
    if group:
        os.kill(app.pid, signal.SIGTERM)
        if raw.poll(lambda: not alive(), 2.0) is not True:
            os.kill(app.pid, signal.SIGKILL)
        if not raw.poll(lambda: not alive(), 2.0):
            raise AssertionError(f"owned process survived: {app.pid}")
    for pid, child in list(_SPAWNED.items()):
        if child.poll() is not None:
            child.wait()
            del _SPAWNED[pid]


def launch_qt(tier: Tier) -> OwnedApp:
    path = Path(__file__).resolve().parents[1] / "apps/qt_window.py"
    log = tier.runtime_dir / "qt-window.log"
    if log.exists():
        log.unlink()
    return launch(tier, str(path), (str(tier.runtime_dir / "qt-window.log"),))


def prime_desktop(tier: Tier) -> None:
    """Activate private portal/keyring services before a leg owns its baseline."""
    if tier.display:
        for key, value in (("index-recursive-directories", "[]"), ("index-single-directories", "[]"),
                           ("enable-monitors", "false"), ("crawling-interval", "-2"), ("initial-sleep", "0")):
            tool(tier, ["gsettings", "set", "org.freedesktop.Tracker3.Miner.Files", key, value])
    names = ("Calculator", "Files", "Terminal", "Text Editor", "Settings") if tier.display else ("Calculator", "Text Editor")
    for name in names:
        app = launch(tier, name)
        stop(app)
    previous = proc.members(tier.runtime_dir)
    stable_since = time.monotonic()
    deadline = stable_since + 45.0
    while time.monotonic() < deadline:
        time.sleep(0.1)
        current = proc.members(tier.runtime_dir)
        if current != previous or any(name == "tracker-extract" for _, _, name in current):
            previous, stable_since = current, time.monotonic()
        if time.monotonic() - stable_since >= 1.0:
            return
    raise AssertionError("private desktop service membership did not settle")
