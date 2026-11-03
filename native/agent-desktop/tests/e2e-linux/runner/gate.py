from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from runner import session

BASE_TOOLS = (
    "Xvfb",
    "dbus-daemon",
    "dbus-update-activation-environment",
    "gdbus",
    "busctl",
    "gsettings",
    "setsid",
    "xprop",
    "xwininfo",
    "xwd",
    "fusermount",
    "timeout",
)

TIER_TOOLS = {
    "x11-openbox": ("xdotool", "wmctrl", "xclip"),
    "x11-mutter": ("gnome-shell", "xdotool", "wmctrl", "xclip"),
    "wayland": ("gnome-shell", "wl-copy", "wl-paste"),
}

TIER_SCRIPTS = {
    "x11-openbox": (session.SCRIPT_PRIVATE_SESSION,),
    "x11-mutter": (session.SCRIPT_PRIVATE_SESSION, session.SCRIPT_MUTTER_SHELL),
    "wayland": (session.SCRIPT_PRIVATE_SESSION, session.SCRIPT_WAYLAND_SHELL),
}


def _default_gi_probe() -> str | None:
    bounded = session._load_bounded_process()
    result = bounded.run_bounded(
        ["python3", "-c", "import gi"], timeout_seconds=15
    )
    if result.returncode != 0:
        return "python3 cannot import gi (PyGObject)"
    return None


def _openbox_path(env: dict[str, str]) -> Path:
    root = env.get("AGENT_DESKTOP_WM_ROOT") or "/"
    return Path(root) / "usr" / "bin" / "openbox"


def _tool_found(tool: str, extra_paths: tuple[Path, ...], which) -> bool:
    if which(tool) is not None:
        return True
    return any((extra / tool).is_file() and os.access(extra / tool, os.X_OK) for extra in extra_paths)


def check_prerequisites(
    tiers: tuple[str, ...] | None = None,
    *,
    which=shutil.which,
    env=None,
    extra_paths: tuple[Path, ...] | None = None,
    gi_probe=None,
    platform: str | None = None,
) -> list[str]:
    env = dict(os.environ if env is None else env)
    platform = sys.platform if platform is None else platform
    extra_paths = () if extra_paths is None else extra_paths
    gi_probe = _default_gi_probe if gi_probe is None else gi_probe
    selected = tuple(tiers) if tiers else tuple(session._INNER_WRAPPERS)
    missing = []
    if not platform.startswith("linux"):
        return ["a linux host is required for the live harness"]
    for tool in BASE_TOOLS:
        if not _tool_found(tool, extra_paths, which):
            missing.append(f"missing tool: {tool}")
    for tier in selected:
        for tool in TIER_TOOLS.get(tier, ()):
            if not _tool_found(tool, extra_paths, which):
                missing.append(f"missing tool for tier {tier}: {tool}")
        for script in TIER_SCRIPTS.get(tier, ()):
            if not script.is_file():
                missing.append(f"missing session script for tier {tier}: {script.name}")
    if "x11-openbox" in selected and not _openbox_path(env).is_file():
        missing.append("missing openbox: set AGENT_DESKTOP_WM_ROOT")
    reason = gi_probe()
    if reason:
        missing.append(reason)
    binary = env.get("AGENT_DESKTOP_E2E_BIN_SRC") or env.get("AGENT_DESKTOP_E2E_BIN") or str(
        session.HARNESS_ROOT.parent.parent / "target" / "release" / "agent-desktop"
    )
    if not Path(binary).is_file():
        missing.append(f"missing release binary: {binary}")
    session_base = Path(
        env.get("AGENT_DESKTOP_SESSION_BASE")
        or (Path(env["XDG_RUNTIME_DIR"]) / "agent-desktop-sessions"
            if env.get("XDG_RUNTIME_DIR") else Path(f"/tmp/agent-desktop-sessions-{os.getuid()}"))
    )
    try:
        session_base.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as error:
        missing.append(f"the session base is not writable: {error}")
    return missing
