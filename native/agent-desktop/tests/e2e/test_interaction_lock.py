import os
import subprocess
import sys
import tempfile
import unittest

import interaction_lock


PROBE = """
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(23)
raise SystemExit(0)
"""


class InteractionLockTests(unittest.TestCase):
    def probe(self, path):
        return subprocess.run(
            [sys.executable, "-c", PROBE, path],
            check=False,
        ).returncode

    def test_outsider_contention_and_inherited_child_crash(self):
        with tempfile.TemporaryDirectory() as root:
            fd = interaction_lock.acquire(root)
            self.assertIsNotNone(fd)
            _, path = interaction_lock.canonical_lock_path(root)
            self.assertEqual(self.probe(path), 23)

            subprocess.run(
                [sys.executable, "-c", "import os; os._exit(71)"],
                pass_fds=(fd,),
                check=False,
            )
            self.assertEqual(self.probe(path), 23)

            os.close(fd)
            self.assertEqual(self.probe(path), 0)

    def test_inherited_holder_can_forward_lease_to_a_child(self):
        with tempfile.TemporaryDirectory() as root:
            fd = interaction_lock.acquire(root)
            self.assertIsNotNone(fd)
            environment = os.environ.copy()
            environment[interaction_lock.LEASE_FD_ENV] = str(fd)
            forwarder = """
import os, subprocess, sys
fd = int(os.environ['AGENT_DESKTOP_INTERACTION_LEASE_FD'])
subprocess.run(
    [sys.executable, '-c', 'import os,sys; os.fstat(int(sys.argv[1]))', str(fd)],
    pass_fds=(fd,),
    check=True,
)
"""
            subprocess.run(
                [sys.executable, "-c", forwarder],
                env=environment,
                pass_fds=(fd,),
                check=True,
            )
            os.close(fd)


if __name__ == "__main__":
    unittest.main()
