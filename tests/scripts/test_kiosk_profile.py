"""Run from the repository root: python tests/scripts/test_kiosk_profile.py."""
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
LAUNCHER = (ROOT / "scripts/start-kiosk.sh").read_text(encoding="utf-8")
PREPARE = re.search(r'python3 - "\$profile" <<\'PY\'\n(.*?)\nPY', LAUNCHER, re.S)[1]


class KioskProfileTests(unittest.TestCase):
    def setUp(self):
        output = ROOT / "artifacts/test-results"
        output.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="kiosk-profile-", dir=output)
        self.profile = pathlib.Path(self.directory.name).resolve()
        self.assertTrue(self.profile.is_relative_to(output.resolve()))
        self.addCleanup(self.directory.cleanup)
        self.preferences = self.profile / "Default/Preferences"
        self.preferences.parent.mkdir()

    def prepare(self):
        subprocess.run([sys.executable, "-c", PREPARE, str(self.profile)], check=True)

    def test_crash_recovery_preserves_other_preferences_and_files(self):
        prefs = {"profile": {"exit_type": "Crashed", "exited_cleanly": False,
                             "name": "Kiosk"}, "translate": {"enabled": False},
                 "unrelated": {"value": "kept"}}
        self.preferences.write_text(json.dumps(prefs), encoding="utf-8")
        cookies = self.profile / "Default/Cookies"
        cookies.write_bytes(b"existing cookie database")
        for _ in range(2):
            self.prepare()
            expected = json.loads(json.dumps(prefs))
            expected["profile"].update(exit_type="Normal", exited_cleanly=True)
            self.assertEqual(json.loads(self.preferences.read_text()), expected)
            self.assertEqual(cookies.read_bytes(), b"existing cookie database")

    def test_new_profile_does_not_require_preferences(self):
        self.prepare()
        self.assertFalse(self.preferences.exists())

    def test_invalid_preferences_are_preserved(self):
        for original in ('{broken', '[]', '{"profile":null}'):
            self.preferences.write_text(original, encoding="utf-8")
            self.prepare()
            self.assertEqual(self.preferences.read_text(), original)


if __name__ == "__main__":
    unittest.main()
