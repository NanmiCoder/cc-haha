"""Use ref addresses to locate raw nodes; read every effect independently."""

import json

from runner.apps import window_id
from runner.helper import nodes, require


def identify(state_root, data):
    refs = [node for node in nodes(data.get("tree", data)) if node.get("ref_id")]
    maps = {}
    for node in refs:
        snapshot_id, local = node["ref_id"].removeprefix("@").split(":", 1)
        if snapshot_id not in maps:
            maps[snapshot_id] = json.loads(
                (state_root / "snapshots" / snapshot_id / "refmap.json").read_text())["inner"]
        entry = maps[snapshot_id]["@" + local]
        node["_identity"] = entry["source_window_id"], tuple(entry.get("path", ()))
    return data


def raw_target(tree, node):
    source, path = node["_identity"]
    matches = [child for child in tree.children() if window_id(child) == source]
    require(len(matches) == 1, f"missing raw source window for {node['ref_id']}")
    target = matches[0]
    for index in path:
        children = target.children()
        require(index < len(children), f"missing raw child {index} below {target.path}")
        target = children[index]
    return target


def same_ref(data, original):
    matches = [node for node in nodes(data.get("tree", data))
               if node.get("_identity") == original["_identity"]
               and node.get("role") == original.get("role")]
    require(len(matches) == 1, f"ref disappeared after reset: {original}")
    return matches[0]
