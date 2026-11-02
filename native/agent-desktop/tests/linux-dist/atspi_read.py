#!/usr/bin/env python3
"""Read a display value straight from the accessibility tree.

The product is never asked what the screen says. This script uses the system
Atspi typelib, finds the named application, and returns the text of its first
Text node. It is the independent observer for the consumer's click leg.

Usage:
    atspi_read.py [--app NAME] [--timeout SECONDS] [--absent]

Prints the text value on stdout (empty when the display is blank) and exits 0.
Exits 1 when the application never registers or no Text node appears.
With --absent it instead waits until no matching application is registered and
exits 0 then, or 1 when one is still registered at the deadline.
"""

import argparse
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402


def walk(node):
    yield node
    try:
        count = node.get_child_count()
    except Exception:
        count = 0
    for index in range(count):
        try:
            child = node.get_child_at_index(index)
        except Exception:
            continue
        yield from walk(child)


def text_value(node):
    try:
        return node.get_string_at_offset(0, Atspi.TextGranularity.WORD).content
    except Exception:
        return None


def find_app_once(name):
    needle = name.casefold()
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        try:
            app = desktop.get_child_at_index(index)
            app_name = (app.get_name() or "").casefold()
        except Exception:
            continue
        if needle in app_name:
            return app
    return None


def find_app(name, deadline):
    while time.monotonic() < deadline:
        app = find_app_once(name)
        if app is not None:
            return app
        time.sleep(0.2)
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default="Calculator")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--absent", action="store_true")
    args = parser.parse_args()

    Atspi.init()
    if args.absent:
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            if find_app_once(args.app) is None:
                return 0
            time.sleep(0.2)
        print(f"atspi_read: {args.app!r} is still registered", file=sys.stderr)
        return 1

    app = find_app(args.app, time.monotonic() + args.timeout)
    if app is None:
        print(f"atspi_read: no application matching {args.app!r} registered", file=sys.stderr)
        return 1

    for node in walk(app):
        try:
            role = node.get_role().value_nick
        except Exception:
            continue
        if role != "text":
            continue
        value = text_value(node)
        if value is not None:
            print(value)
            return 0

    print(f"atspi_read: {args.app!r} has no readable Text node", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
