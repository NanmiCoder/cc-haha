import unittest
from types import SimpleNamespace
from unittest.mock import patch

from runner.product import Envelope
from scenarios import lifecycle


class LifecycleScenarioTests(unittest.TestCase):
    def test_geometry_and_restore_use_visible_bounds_inside_client_shadows(self):
        raw = [39, 45, 862, 672]
        restored = []
        def product(argv):
            if argv[0] == "resize-window":
                raw[2:] = [int(argv[4]) + 122, int(argv[6]) + 122]
            else:
                self.assertEqual(argv[0], "move-window")
                raw[:2] = [int(argv[4]) - 61, int(argv[6]) - 55]
            return Envelope(True, {}, None, "{}", 0, argv)
        def changed(read, expected, **kw):
            self.assertEqual(read(), expected)
            return read()
        ctx = SimpleNamespace(tier=object(), product=product,
                              restored=lambda key, value: restored.append(value))
        with patch.object(lifecycle.x11, "geometry", side_effect=lambda *a: tuple(raw)), \
             patch.object(lifecycle, "frame_extents", return_value=(61, 61, 55, 67)), \
             patch.object(lifecycle, "changed", side_effect=changed):
            self.assertEqual(lifecycle._geometry(ctx, "w-test"), (100, 100, 740, 550))
            lifecycle._restore_geometry(ctx, "w-test", (100, 100, 700, 520))
        self.assertEqual(restored, [(100, 100, 700, 520)])
        self.assertEqual(raw, [39, 45, 822, 642])

    def test_maximize_requires_both_axes_and_restore_requires_neither(self):
        vert, horz = "_NET_WM_STATE_MAXIMIZED_VERT", "_NET_WM_STATE_MAXIMIZED_HORZ"
        for maximized, restored, accepted in ((vert, "", False), (horz, "", False),
                (vert + ", " + horz, vert, False), (vert + ", " + horz, horz, False),
                (vert + ", " + horz, "", True)):
            with self.subTest(maximized=maximized, restored=restored):
                state = [""]
                def product(argv):
                    state[0] = maximized if argv[0] == "maximize" else restored
                    return Envelope(True, {}, None, "{}", 0, argv)
                ctx = SimpleNamespace(tier=object(), product=product,
                    before=lambda *a: None, after=lambda *a: None, restored=lambda *a: None)
                def changed(read, expected, **kw):
                    assert read() == expected, "window still maximized on one axis"
                    return expected
                with patch.object(lifecycle.apps, "launch", return_value=SimpleNamespace(windows=["w-test"])), \
                    patch.object(lifecycle.apps, "stop"), \
                    patch.object(lifecycle, "_wm_state", side_effect=lambda *a: state[0]), \
                    patch.object(lifecycle.atspi_raw, "poll", side_effect=lambda read,*a: read()), \
                    patch.object(lifecycle, "changed", side_effect=changed):
                    if accepted:
                        lifecycle.maximize_restore(ctx)
                    else:
                        with self.assertRaises(AssertionError):
                            lifecycle.maximize_restore(ctx)
