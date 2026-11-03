import signal
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

from private_bus import stop


class PrivateBusTests(unittest.TestCase):
    def run_stop(self, before, after=None):
        with TemporaryDirectory() as root:
            directory = Path(root) / "123"
            directory.mkdir()
            sender, closer, opener = Mock(), Mock(), Mock(return_value=41)
            read = Mock(side_effect=[before, before if after is None else after])
            stopped = stop("/private", Path(root), opener, sender, closer, read)
            return stopped, sender, closer, opener

    def bus(self, start=77, runtime=b"/private", comm="dbus-daemon"):
        return start, [b"XDG_RUNTIME_DIR=" + runtime], comm, b"dbus-daemon\0--config-file=at-spi\0"

    def test_private_bus_is_signalled_through_its_open_handle(self):
        stopped, sender, closer, opener = self.run_stop(self.bus())
        self.assertEqual(len(stopped), 1)
        opener.assert_called_once_with(123, 0)
        sender.assert_called_once_with(41, signal.SIGTERM, None, 0)
        closer.assert_called_once_with(41)

    def test_similar_runtime_and_unrelated_process_are_never_opened(self):
        for value in (self.bus(runtime=b"/private-other"), self.bus(comm="unrelated")):
            stopped, sender, closer, opener = self.run_stop(value)
            self.assertEqual(stopped, [])
            opener.assert_not_called()
            sender.assert_not_called()

    def test_reused_pid_is_not_signalled(self):
        stopped, sender, closer, opener = self.run_stop(self.bus(), self.bus(start=78))
        self.assertEqual(stopped, [])
        sender.assert_not_called()
        closer.assert_called_once_with(41)

    def test_runtime_is_checked_again_after_opening_the_handle(self):
        stopped, sender, closer, opener = self.run_stop(self.bus(), self.bus(runtime=b"/foreign"))
        self.assertEqual(stopped, [])
        sender.assert_not_called()
        closer.assert_called_once_with(41)
