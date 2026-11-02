from __future__ import annotations

from scenarios.headed_actions import find_ref as qualified_ref


def walk(node) -> list:
    nodes = [node]
    for child in node.children():
        nodes.extend(walk(child))
    return nodes


def active_names(root) -> list[str]:
    return [
        node.name
        for node in walk(root)
        if "ACTIVE" in getattr(node, "states", frozenset()) and node.name
    ]


def search(value, needle: str) -> bool:
    target = needle.lower()
    if isinstance(value, str):
        return target in value.lower()
    if isinstance(value, dict):
        return any(search(key, needle) or search(item, needle) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(search(item, needle) for item in value)
    return False


def first_ref(tree: dict | None) -> str | None:
    return qualified_ref(tree)
