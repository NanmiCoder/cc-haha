import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class LifetimeTests(unittest.TestCase):
    def test_every_cycle_requires_a_success_envelope(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "lifetime.c"
            source.write_text(r'''
#define main consumer_main
#include "consumer.c"
#undef main
static int alive, calls, frees, destroyed, bad_cycle;
static const char *payload;
struct AdAdapter *ad_adapter_create(void) {
  alive = 1;
  return (struct AdAdapter *)&alive;
}
void ad_adapter_destroy(struct AdAdapter *adapter) { (void)adapter; alive = 0; destroyed++; }
void ad_free_string(char *out) { frees++; free(out); }
AdResult ad_snapshot(const struct AdAdapter *adapter, const char *app, int32_t surface,
                     uint8_t depth, bool interactive, bool compact, char **out) {
  (void)adapter; (void)app; (void)surface; (void)depth; (void)interactive; (void)compact;
  if (!alive) return AD_RESULT_ERR_INVALID_ARGS;
  calls++;
  const char *value = calls == bad_cycle ? payload : "{\"ok\":true}";
  *out = value ? strdup(value) : NULL;
  return AD_RESULT_OK;
}
int main(int argc, char **argv) {
  bad_cycle = atoi(argv[1]);
  payload = argc > 2 ? argv[2] : NULL;
  int result = cmd_lifetime(NULL, "app");
  if (frees != calls - (!payload && calls >= bad_cycle) ||
      destroyed != calls + (result == 0)) return 90;
  return result;
}
''')
            binary = Path(directory) / "lifetime"
            strip = "-Wl,-dead_strip" if sys.platform == "darwin" else "-Wl,--gc-sections"
            subprocess.run([shutil.which("cc") or "cc", "-O2", "-ffunction-sections", strip,
                            f"-I{root / 'tests/linux-dist'}", f"-I{root / 'crates/ffi/include'}",
                            str(source), "-o", str(binary)], check=True, capture_output=True)
            for cycle in (1, 20):
                for payload, expected in ((None, 1), ('{"ok":false}', 1),
                        ('{"ok":false,"error":{"details":{"ok":true}}}', 1),
                        ('{"data":{"ok":true}}', 1), ('{"ok":1}', 1),
                        ('{"ok":true} trailing', 1), ('{"ok": true,"data":{"ok":false}}', 0),
                        ('{"ok":true}', 0)):
                    with self.subTest(cycle=cycle, payload=payload):
                        result = subprocess.run([str(binary), str(cycle),
                                                 *([] if payload is None else [payload])],
                                                capture_output=True, text=True)
                        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                        if expected:
                            self.assertIn(f"SNAPSHOT_ENVELOPE rc=0 cycle={cycle - 1}", result.stderr)
