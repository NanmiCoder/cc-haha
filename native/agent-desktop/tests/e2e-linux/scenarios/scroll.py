from uuid import uuid4

from oracle.atspi_raw import poll
from runner.helper import (changed, command, managed, one, ref, require, root,
                           stale_twin)
from runner.legs import implementation
from runner.verdict import LegContext


def realised(tree):
    return sorted({node.name for node in tree.walk() if node.name.startswith("file")
                   and node.name.endswith(".txt")})


def scroll_target(bar):
    maximum = float(bar.get_property("org.a11y.atspi.Value", "MaximumValue"))
    minimum = float(bar.get_property("org.a11y.atspi.Value", "MinimumValue"))
    require(maximum > minimum, "scrollbar has no range")
    return minimum + (maximum - minimum) * 0.98


def raw_value(bar, value):
    from gi.repository import GLib
    bar.invoke("org.freedesktop.DBus.Properties", "Set", "(ssv)",
               ("org.a11y.atspi.Value", "CurrentValue", GLib.Variant("d", value)))
