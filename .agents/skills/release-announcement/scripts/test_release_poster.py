import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from release_poster import PALETTE, check_spec, release_section, render, scan, wrap_lines


class ReleasePosterTest(unittest.TestCase):
    def test_latest_semver_and_english_credits(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            notes = repo / "release-notes"
            notes.mkdir()
            (notes / "v0.6.9.md").write_text("# v0.6.9\nThis release fixes a desktop loading problem. Thanks **@latest-user**\n<details>\n这是旧的中文版本 @chinese-only\n", encoding="utf-8")
            (notes / "v0.6.8.md").write_text("# v0.6.8\nThis release fixes a desktop loading problem. Thanks **@old-user**\n", encoding="utf-8")
            result = scan(repo)
            self.assertEqual(result["version"], "0.6.9")
            self.assertEqual([person["login"] for person in result["mentions"]], ["latest-user"])
            older = scan(repo, "v0.6.8")
            self.assertEqual(older["version"], "0.6.8")
            self.assertEqual([person["login"] for person in older["mentions"]], ["old-user"])

    def test_english_section_in_either_order_and_without_details(self):
        title = "# Claude Code Haha v0.5.4\n"
        english = "English changes here: the desktop app reconnects reliably after sleep.\n"
        english_only = title + english
        english_first = title + english + "<details>\n<summary>中文版本</summary>\n" + title + "这里是中文修复内容和版本更新。\n</details>"
        chinese_first = title + "这里是中文修复内容和版本更新。\n<details>\n<summary>English Version</summary>\n" + title + english + "</details>"
        no_details = title + "这里是中文修复内容和版本更新。\n" + title + english
        for markdown in (english_only, english_first, chinese_first, no_details):
            selected = release_section(markdown)
            self.assertIn("English changes", selected)
            self.assertNotIn("中文", selected)
            self.assertNotIn("<summary>", selected)

    def test_note_without_english_body_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "No English release body"):
            release_section("# Claude Code Haha v0.1.0\n这里只有中文修复内容。\n")

    def test_english_credit_phrases(self):
        cases = {
            "Thanks @alice.": True,
            "- Fixed reconnects (#42). Thanks to @alice.": True,
            "Credits: @alice": True,
            "Contributors: @bob, @alice": True,
            "Contributed by @alice": True,
            "- PR template asks @alice to review.": False,
        }
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            notes = repo / "release-notes"
            notes.mkdir()
            for index, (line, expected) in enumerate(cases.items()):
                (notes / f"v0.0.{index}.md").write_text(f"# Claude Code Haha v0.0.{index}\nThis release contains fixes.\n{line}\n", encoding="utf-8")
                result = scan(repo, f"0.0.{index}")
                credited = {person["login"]: person["credit_candidate"] for person in result["mentions"]}
                with self.subTest(line=line):
                    self.assertEqual(credited["alice"], expected)

    def test_incidental_mention_is_not_contributor_credit(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            notes = repo / "release-notes"
            notes.mkdir()
            (notes / "v0.2.0.md").write_text(
                "# Claude Code Haha v0.2.0\nThis release fixes desktop problems.\n- The PR template asks @dosubot to review by default.\n- Fixed a connection problem **@actual-author** (#42).\n",
                encoding="utf-8",
            )
            result = scan(repo)
            candidates = {person["login"]: person["credit_candidate"] for person in result["mentions"]}
            self.assertEqual(candidates, {"dosubot": False, "actual-author": True})
            spec = {
                "version": "0.2.0", "features": [], "fixes": [{"title": "Fix", "body": "Details"}],
                "contributors": [{"login": "dosubot", "contribution": "Code contribution"}],
            }
            with self.assertRaisesRegex(ValueError, "not explicitly credited"):
                check_spec(spec, result)

    def test_cannot_credit_unmentioned_account(self):
        source = {"version": "0.6.7", "mentions": [{"login": "actual-author", "credit_candidate": True}]}
        spec = {
            "version": "0.6.7",
            "features": [{"title": "Feature", "body": "Details"}],
            "fixes": [{"title": "Fix", "body": "Details"}],
            "contributors": [{"login": "different-author", "contribution": "Contribution"}],
        }
        with self.assertRaisesRegex(ValueError, "not explicitly credited"):
            check_spec(spec, source)

    def test_offline_avatar_requires_explicit_test_mode(self):
        source = {"version": "0.6.7", "mentions": [{"login": "actual-author", "credit_candidate": True}]}
        spec = {
            "version": "0.6.7", "features": [], "fixes": [{"title": "Fix", "body": "Details"}],
            "contributors": [{"login": "actual-author", "contribution": "Fix", "avatar_path": "fake.png"}],
        }
        with self.assertRaisesRegex(ValueError, "only for explicit offline tests"):
            check_spec(spec, source)
        check_spec(spec, source, allow_offline_avatars=True)

    def test_chinese_punctuation_does_not_start_a_wrapped_line(self):
        width = 4
        measure = len
        for value in ("这是测试；继续", "这是测试。继续", "这是测试、继续", "测试「功能描述"):
            lines = wrap_lines(value, width, measure)
            self.assertTrue(all(not line.startswith(("；", "。", "、")) for line in lines[1:]))
            self.assertTrue(all(not line.endswith("「") for line in lines[:-1]))

    def test_ascii_punctuation_does_not_start_a_wrapped_line(self):
        for value in ("a task is running; it takes effect", "see the note (details) here, then done."):
            for width in range(8, 24):
                lines = wrap_lines(value, width, len)
                self.assertEqual("".join(lines).replace(" ", ""), value.replace(" ", ""))
                self.assertTrue(all(not line.startswith((";", ",", ".", ")")) for line in lines[1:]), lines)
                self.assertTrue(all(not line.endswith("(") for line in lines[:-1]), lines)

    def test_overwide_latin_tokens_wrap_without_losing_characters(self):
        value = "https://example.invalid/" + "long-model-name-" * 12
        lines = wrap_lines(value, 22, len)
        self.assertEqual("".join(lines), value)
        self.assertTrue(all(0 < len(line) <= 22 for line in lines))
        self.assertEqual(wrap_lines("模型名称\n下一行", 10, len), ["模型名称", "下一行"])

    def test_near_full_width_latin_word_with_cjk_brackets(self):
        # CJK brackets are wider than Latin glyphs; moving an intact word
        # together with its bracket can overflow even when the word fits.
        def measure(value):
            return sum(1 if char == "W" else 2 for char in value)

        for value in ("功能（" + "W" * 7 + "）", "（" + "W" * 7 + "）"):
            lines = wrap_lines(value, 8, measure)
            self.assertEqual("".join(lines), value)
            self.assertTrue(all(line and measure(line) <= 8 for line in lines))
            self.assertTrue(all(not line.startswith("）") for line in lines))
            self.assertTrue(all(not line.endswith("（") for line in lines))

    def render_fixture(self, spec, source, directory, offline=False):
        from PIL import Image, ImageDraw

        output = directory / "poster.png"
        text_bounds = []
        original_text = ImageDraw.ImageDraw.text

        def record_text(draw, xy, text, **kwargs):
            bounds = draw.textbbox(xy, text, font=kwargs["font"], anchor=kwargs["anchor"], stroke_width=kwargs.get("stroke_width", 0))
            text_bounds.append((text, bounds, kwargs["font"].size))
            return original_text(draw, xy, text, **kwargs)

        with patch.object(ImageDraw.ImageDraw, "text", new=record_text):
            size = render(spec, source, directory / "spec.json", output, offline)
        with Image.open(output) as poster:
            self.assertEqual(poster.size, size)
            self.assertEqual(poster.mode, "RGB")
        # Check actual glyph extents, including every wrapped line and footer.
        for text, (left, top, right, bottom), _ in text_bounds:
            self.assertGreaterEqual(left, 64, text)
            self.assertLessEqual(right, 1016, text)
            self.assertGreaterEqual(top, 0, text)
            self.assertLess(bottom, size[1], text)
        for index, (text, bounds, _) in enumerate(text_bounds):
            for other, other_bounds, _ in text_bounds[index + 1:]:
                left, top = max(bounds[0], other_bounds[0]), max(bounds[1], other_bounds[1])
                right, bottom = min(bounds[2], other_bounds[2]), min(bounds[3], other_bounds[3])
                self.assertFalse(left < right and top < bottom, f"Overlap: {text} / {other}")
        return text_bounds, size

    def test_render_feature_and_fix_only_variants_without_empty_sections(self):
        source = {"version": "0.7.0", "mentions": []}
        for count in (0, 1, 3, 6):
            with self.subTest(features=count), tempfile.TemporaryDirectory() as directory:
                spec = {
                    "version": "0.7.0",
                    "features": [{"title": f"Improved feature {index}", "body": "You can now finish the task while keeping the required conditions."} for index in range(count)],
                    "fixes": [] if count else [{"title": "Fixed connection", "body": "Work continues once the connection is restored."}],
                    "contributors": [],
                }
                texts, _ = self.render_fixture(spec, source, Path(directory))
                labels = [entry[0] for entry in texts]
                # The lead feature lives in the hero; the list starts at 02.
                self.assertEqual("Highlight" in labels, bool(count))
                self.assertEqual("New and improved" in labels, count > 1)
                self.assertEqual("Key fixes" in labels, not count)
                self.assertEqual("Fix release · 1 fix" in labels, not count)
                self.assertNotIn("Thanks to community contributors", labels)
                self.assertNotIn("Install note", labels)
                if count:
                    self.assertTrue(any(size >= 36 and "You can now" in text for text, _, size in texts))

    def test_lead_feature_is_readable_on_the_first_phone_screen(self):
        source = {"version": "0.7.0", "mentions": []}
        spec = {
            "version": "0.7.0",
            "features": [{"title": "Desktop UI redesigned", "body": "A new visual system covers every page: tool calls become a timeline, messages use bubbles, and the composer becomes a floating card."}],
            "fixes": [], "contributors": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            texts, _ = self.render_fixture(spec, source, Path(directory))
        # A 390px-wide phone shows roughly the top 1700px of a 1080px poster.
        lead = [bounds for text, bounds, _ in texts if "floating card" in text]
        self.assertTrue(lead)
        self.assertLess(max(bottom for _, _, _, bottom in lead), 1100)

    def test_paragraphs_are_balanced_instead_of_leaving_an_orphan(self):
        source = {"version": "0.7.0", "mentions": []}
        # 23 characters at 36px in the 792px column would leave one on the last line.
        spec = {"version": "0.7.0", "features": [{"title": "Title", "body": "说" * 23}], "fixes": [], "contributors": []}
        with tempfile.TemporaryDirectory() as directory:
            texts, _ = self.render_fixture(spec, source, Path(directory))
        body_lines = [text for text, _, _ in texts if set(text) == {"说"}]
        self.assertEqual("".join(body_lines), "说" * 23)
        self.assertGreater(len(body_lines), 1)
        self.assertTrue(all(len(line) >= 8 for line in body_lines), body_lines)

    def test_paragraphs_with_a_long_last_line_keep_the_full_measure(self):
        source = {"version": "0.7.0", "mentions": []}
        # 36 characters wrap as 22 + 14; full balancing would squeeze them to 18 + 18.
        spec = {"version": "0.7.0", "features": [{"title": "Title", "body": "说" * 36}], "fixes": [], "contributors": []}
        with tempfile.TemporaryDirectory() as directory:
            texts, _ = self.render_fixture(spec, source, Path(directory))
        body_lines = [text for text, _, _ in texts if set(text) == {"说"}]
        self.assertEqual(len(body_lines), 2)
        self.assertGreaterEqual(len(body_lines[0]), 21, body_lines)

    def test_render_long_content_and_multiple_offline_contributors(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            Image.new("RGB", (100, 80), "#95624A").save(directory / "avatar.png")
            logins = ["fixture-author", "a" * 39]
            source = {"version": "10.120.3000", "mentions": [{"login": login, "credit_candidate": True} for login in logins]}
            spec = {
                "version": "10.120.3000",
                "product": "A very long product name " * 7,
                "features": [{"title": "A very long feature title " * 8, "body": "Body text " * 30 + "\n" + "LongModelName" * 20}],
                "fixes": [{"title": "Fixed past tasks", "body": "Runs only after confirmation and keeps the original state on failure."}],
                "extras": [{"title": "More model changes " * 8, "headline": "New models " * 12, "body": "Model conditions " * 20}],
                "contributors": [{"login": login, "contribution": "A long contribution summary " * 30, "avatar_path": "avatar.png"} for login in logins],
                "install_note": "Install reminder " * 40,
                "footer_url": "https://example.invalid/" + "long-path/" * 30,
            }
            with patch("release_poster.urlopen", side_effect=AssertionError("tests must not access the network")):
                texts, _ = self.render_fixture(spec, source, directory, offline=True)
            labels = [entry[0] for entry in texts]
            for login in logins:
                self.assertIn("@" + login, "".join(labels))

    def test_overheight_render_fails_without_saving_a_clipped_poster(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            spec = {"version": "0.7.0", "features": [], "fixes": [{"title": "Fix", "body": "Multi-line body\n" * 400}], "contributors": []}
            with self.assertRaisesRegex(ValueError, "exceeds the limit"):
                render(spec, {"version": "0.7.0"}, directory / "spec.json", directory / "poster.png")
            self.assertFalse((directory / "poster.png").exists())

    def test_body_contrast_on_paper_and_highlight_surface(self):
        def luminance(hex_color):
            channels = [int(hex_color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
            linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
            return sum(value * weight for value, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

        def contrast(first, second):
            high, low = sorted((luminance(PALETTE[first]), luminance(PALETTE[second])), reverse=True)
            return (high + 0.05) / (low + 0.05)

        for text, surface, minimum in (
            ("body", "paper", 7), ("body", "panel", 7), ("night_body", "ink", 7),
            ("ink", "signal", 4.5), ("signal", "ink", 4.5), ("accent_ink", "paper", 4.5), ("accent_ink", "panel", 4.5),
        ):
            with self.subTest(text=text, surface=surface):
                self.assertGreaterEqual(contrast(text, surface), minimum)


if __name__ == "__main__":
    unittest.main()
