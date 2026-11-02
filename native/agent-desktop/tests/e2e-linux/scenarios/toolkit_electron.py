from oracle import atspi_raw as raw, proc
from runner.helper import require
from runner.legs import implementation
from runner.verdict import LegContext


def frame_alive(ctx, app):
    owners = [node for node in raw.registry(ctx.tier) if node.bus in app.owner_names]
    require(len(owners) == 1, "VS Code frame owner vanished")
    require(proc.facts(app.pid)[0] == app.start_time, "VS Code process generation changed")
    from runner.apps import window_id
    windows = [window_id(node) for node in owners[0].children() if node.role in (16, 23, 69)]
    require(set(app.windows).issubset(windows), "VS Code frame vanished")
    return windows


def dropdown(tree):
    return [node.name for node in tree.find(role=35) if "SHOWING" in node.states
            and node.name not in ("File", "Edit", "Selection", "View", "Go", "More", "Run", "Terminal", "Help")]
