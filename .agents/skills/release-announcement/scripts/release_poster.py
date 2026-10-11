#!/usr/bin/env python3
"""Find a release note and render an editorial, text-accurate WeChat poster."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from collections import deque
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


VERSION_RE = re.compile(r"^release-notes/v(\d+)\.(\d+)\.(\d+)\.md$")
LOGIN_RE = re.compile(r"(?<![A-Za-z0-9._%+-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)")
RELEASE_HEADING_RE = re.compile(r"(?m)^#\s+Claude Code Haha v\d+\.\d+\.\d+\s*$")
CLOSING_PUNCTUATION = set("，。、；：！？）》」』】〕”’％")
OPENING_PUNCTUATION = set("（《「『【〔“‘")
POSTER_WIDTH = 1080
MAX_POSTER_HEIGHT = 16000
MARGIN, RIGHT = 64, 1016
CONTENT_WIDTH = RIGHT - MARGIN
# Swiss layout: one signal-orange hero, a paper body, an ink closing band.
PALETTE = {
    "signal": "#FF5B23",
    "paper": "#F1F0EB",
    "panel": "#E3E1D9",
    "ink": "#151515",
    "body": "#3B3B38",
    "accent_ink": "#A8340B",
    "night_text": "#F1F0EB",
    "night_body": "#CFCCC4",
    "night_rule": "#3A3A38",
}
# (path, collection index). Hiragino Sans GB: 0 = W3, 2 = W6; Noto CJK: 2 = SC.
FONT_CANDIDATES = {
    "regular": [
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
        ("/System/Library/Fonts/STHeiti Light.ttc", 1),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2),
        ("C:/Windows/Fonts/msyh.ttc", 0),
    ],
    "bold": [
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 2),
        ("/System/Library/Fonts/STHeiti Medium.ttc", 1),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2),
        ("C:/Windows/Fonts/msyhbd.ttc", 0),
    ],
    "heavy": [
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc", 2),
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 2),
        ("/System/Library/Fonts/STHeiti Medium.ttc", 1),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2),
        ("C:/Windows/Fonts/msyhbd.ttc", 0),
    ],
    # Latin-only numerals: version, item numbers.
    "display": [
        ("/System/Library/Fonts/HelveticaNeue.ttc", 9),
        ("/System/Library/Fonts/Avenir Next Condensed.ttc", 8),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf", 0),
        ("C:/Windows/Fonts/arialbd.ttf", 0),
    ],
}


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def release_candidates(repo):
    notes = repo / "release-notes"
    candidates = []
    if notes.is_dir():
        for path in notes.glob("v*.md"):
            relative = path.relative_to(repo).as_posix()
            match = VERSION_RE.fullmatch(relative)
            if match:
                candidates.append((tuple(map(int, match.groups())), 4, "working-tree", relative))

    for rank, ref in ((3, "HEAD"), (2, "main"), (1, "origin/main")):
        result = git(repo, "ls-tree", "-r", "--name-only", ref, "--", "release-notes")
        if result.returncode:
            continue
        for relative in result.stdout.splitlines():
            match = VERSION_RE.fullmatch(relative)
            if match:
                candidates.append((tuple(map(int, match.groups())), rank, ref, relative))
    return candidates


def chinese_release_section(markdown):
    headings = list(RELEASE_HEADING_RE.finditer(markdown))
    if len(headings) >= 2:
        sections = [
            markdown[heading.start():(headings[index + 1].start() if index + 1 < len(headings) else len(markdown))]
            for index, heading in enumerate(headings)
        ]
    else:
        sections = [markdown]
    # Older releases put English first and Chinese in <details>; others invert
    # that order or repeat the H1 without <details>.
    candidates = []
    for section in sections:
        candidates.extend(re.split(r"(?i)<details(?:\s[^>]*)?>", section))
    selected = max(candidates, key=lambda part: len(re.findall(r"[\u4e00-\u9fff]", part)))
    if len(re.findall(r"[\u4e00-\u9fff]", selected)) < 10:
        raise ValueError("发布说明里未找到足够的中文正文，请人工核对语言版本")
    return re.sub(r"(?is)</?details[^>]*>|<summary[^>]*>.*?</summary>", "", selected).strip() + "\n"


def is_explicit_credit(line, login):
    escaped = re.escape(login)
    if re.search(rf"\*\*@{escaped}\*\*", line, re.IGNORECASE):
        return True
    return bool(re.search(rf"(?:感谢|致谢|代码贡献者|贡献者)[^\n@]{{0,70}}@{escaped}\b", line, re.IGNORECASE))


def wrap_lines(value, width, measure):
    result, current = [], ""
    # Latin model names and IDs stay together; CJK wraps character by character.
    tokens = re.findall(r"@?[A-Za-z0-9][A-Za-z0-9._/+:-]*|.", str(value), flags=re.DOTALL)
    # An unbroken URL/model name must never escape the image's safe area.
    pending = deque(part for token in tokens for part in (list(token) if token != "\n" and measure(token) > width else [token]))
    while pending:
        token = pending.popleft()
        if token == "\n":
            result.append(current)
            current = ""
            continue
        trial = current + token
        if current and measure(trial) > width:
            if token in CLOSING_PUNCTUATION:
                tail_match = re.search(r"(?:[A-Za-z0-9._/+:-]+|.)$", current)
                tail = tail_match.group(0) if tail_match else ""
                if measure(tail + token) > width:
                    tail = current[-1]
                prefix = current[:-len(tail)].rstrip() if tail else ""
                if prefix:
                    result.append(prefix)
                current = tail + token
                if measure(current) > width:
                    raise ValueError("排版宽度不足以容纳标点，请增加可用宽度")
            elif current[-1] in OPENING_PUNCTUATION:
                prefix = current[:-1].rstrip()
                if prefix:
                    result.append(prefix)
                current = current[-1]
                if measure(current + token) > width:
                    if len(token) == 1:
                        raise ValueError("排版宽度不足以容纳标点，请增加可用宽度")
                    pending.extendleft(reversed(list(token)))
                else:
                    current += token
            else:
                result.append(current.rstrip())
                current = token.lstrip()
        else:
            current = trial
    result.append(current)
    return result


def scan(repo, requested_version=None):
    candidates = release_candidates(repo)
    if requested_version:
        requested = requested_version.removeprefix("v")
        if not re.fullmatch(r"\d+\.\d+\.\d+", requested):
            raise ValueError(f"无效版本号：{requested_version}")
        target = tuple(map(int, requested.split(".")))
        candidates = [candidate for candidate in candidates if candidate[0] == target]
    if not candidates:
        label = requested_version or "最新版本"
        raise ValueError(f"未找到 {label} 的 release-notes Markdown")
    version, _, source, relative = max(candidates)
    if source == "working-tree":
        markdown = (repo / relative).read_text(encoding="utf-8")
    else:
        result = git(repo, "show", f"{source}:{relative}")
        if result.returncode:
            raise ValueError(f"无法从 {source} 读取 {relative}: {result.stderr.strip()}")
        markdown = result.stdout

    chinese = chinese_release_section(markdown)
    mentions = {}
    for line in chinese.splitlines():
        for match in LOGIN_RE.finditer(line):
            login = match.group(1)
            key = login.lower()
            entry = mentions.setdefault(key, {"login": login, "lines": [], "credit_candidate": False})
            if line not in entry["lines"]:
                entry["lines"].append(line.strip())
            if is_explicit_credit(line, login):
                entry["credit_candidate"] = True

    return {
        "version": ".".join(map(str, version)),
        "source": source,
        "path": relative,
        "sha256": hashlib.sha256(chinese.encode("utf-8")).hexdigest(),
        "chinese_markdown": chinese,
        "mentions": list(mentions.values()),
    }


def choose_font(role):
    for path, index in FONT_CANDIDATES[role]:
        if Path(path).is_file():
            return path, index
    if role == "display":
        return choose_font("bold")
    raise RuntimeError("缺少可用的中文系统字体；请提供冬青黑体、华文黑体、Noto Sans CJK 或微软雅黑")


def check_spec(spec, scan_data, allow_offline_avatars=False):
    if not isinstance(spec, dict):
        raise ValueError("poster spec 必须是 JSON 对象")
    if spec.get("version") != scan_data.get("version"):
        raise ValueError("poster spec 的 version 与最新 release note 不一致")
    for field in ("features", "fixes", "contributors"):
        if not isinstance(spec.get(field), list):
            raise ValueError(f"poster spec 缺少数组字段 {field}")
    if not spec["features"] and not spec["fixes"]:
        raise ValueError("至少需要一个主要功能或修复项")
    if len(spec["features"]) > 6 or len(spec["fixes"]) > 12:
        raise ValueError("内容过多：最多 6 项功能、12 项修复，请先提炼")
    mention_ids = {m["login"].lower() for m in scan_data.get("mentions", []) if m.get("credit_candidate") is True}
    seen = set()
    for person in spec["contributors"]:
        login = person.get("login", "")
        if not isinstance(login, str) or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", login):
            raise ValueError(f"无效 GitHub ID: {login!r}")
        if login.lower() not in mention_ids:
            raise ValueError(f"贡献者 @{login} 未在 release note 中文部分明确署名")
        if login.lower() in seen:
            raise ValueError(f"重复的贡献者 @{login}")
        seen.add(login.lower())
        if not person.get("contribution"):
            raise ValueError(f"缺少 @{login} 的贡献概述")
        if person.get("avatar_path") and not allow_offline_avatars:
            raise ValueError("avatar_path 仅供显式离线测试使用，正式成图必须核验 GitHub 头像")
    for field in ("features", "fixes"):
        for item in spec[field]:
            if not item.get("title") or not item.get("body"):
                raise ValueError(f"{field} 每项都需要 title 和 body")
    if not isinstance(spec.get("extras", []), list):
        raise ValueError("extras 必须是数组")
    for extra in spec.get("extras", []):
        if not all(extra.get(key) for key in ("title", "headline", "body")):
            raise ValueError("extras 每项需要 title、headline、body")


def get_avatar(person, spec_path, avatar_dir, allow_offline_avatars=False):
    from PIL import Image

    login = person["login"]
    if person.get("avatar_path"):
        if not allow_offline_avatars:
            raise ValueError("正式成图不能使用 avatar_path")
        path = Path(person["avatar_path"])
        if not path.is_absolute():
            path = spec_path.parent / path
        return Image.open(path).convert("RGB")

    request = Request(
        "https://api.github.com/users/" + quote(login),
        headers={"Accept": "application/vnd.github+json", "User-Agent": "cc-haha-release-announcement"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            profile = json.load(response)
        if profile.get("login", "").lower() != login.lower():
            raise ValueError(f"GitHub 返回的账号与 @{login} 不符")
        url = profile.get("avatar_url")
        if not url:
            raise ValueError(f"@{login} 没有公开头像地址")
        image_request = Request(url + "&s=256", headers={"User-Agent": "cc-haha-release-announcement"})
        with urlopen(image_request, timeout=20) as response:
            content = response.read()
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"获取 @{login} 的 GitHub 头像失败：{exc}") from exc
    avatar_dir.mkdir(parents=True, exist_ok=True)
    path = avatar_dir / (login + ".png")
    path.write_bytes(content)
    return Image.open(path).convert("RGB")


def render(spec, scan_data, spec_path, output, allow_offline_avatars=False):
    from PIL import Image, ImageDraw, ImageFont, ImageOps

    check_spec(spec, scan_data, allow_offline_avatars)
    p = PALETTE
    margin, right, content_width = MARGIN, RIGHT, CONTENT_WIDTH
    body_x, body_width = margin + 160, content_width - 160
    product = str(spec.get("product") or "Claude Code Haha")
    features, extras, fixes, people = spec["features"], spec.get("extras", []), spec["fixes"], spec["contributors"]
    faces, strokes, avatars = {}, {}, {}

    def face(size, role="regular"):
        key = (size, role)
        if key not in faces:
            path, index = choose_font(role)
            faces[key] = ImageFont.truetype(path, size, index=index)
            # Without a black weight, only display-size headings get a 1px
            # stroke; thicker strokes fill in dense characters such as 重.
            strokes[faces[key]] = 1 if role == "heavy" and size >= 60 and "Black" not in path else 0
        return faces[key]

    def avatar(person):
        if person["login"] not in avatars:
            photo = get_avatar(person, spec_path, output.parent / "avatars", allow_offline_avatars)
            avatars[person["login"]] = ImageOps.fit(photo, (96, 96), method=Image.Resampling.LANCZOS)
        return avatars[person["login"]]

    def layout(canvas, paint):
        """Lay out the whole poster; draw only when paint is true. Returns (height, bands)."""
        draw = ImageDraw.Draw(canvas)
        bands = []

        def measure(text, text_face):
            return draw.textlength(text, font=text_face) + 2 * strokes[text_face]

        def lines(value, text_face, width):
            return wrap_lines(value, width, lambda text: measure(text, text_face))

        def put(x, y, text, text_face, color, anchor="lt"):
            if paint:
                width = strokes[text_face]
                x += width if anchor[0] == "l" else -width
                draw.text((x, y), text, font=text_face, fill=color, anchor=anchor, stroke_width=width, stroke_fill=color)

        def rect(box, **style):
            if paint:
                draw.rectangle(box, **style)

        def balanced(value, text_face, width):
            # A paragraph ending on a short tail (an orphaned character or two)
            # is rebalanced by narrowing the measure while the line count holds.
            best = lines(value, text_face, width)
            if len(best) < 2 or measure(best[-1], text_face) >= width / 3:
                return best
            low, high = int(width * 0.6), int(width)
            while low < high:
                middle = (low + high) // 2
                try:
                    trial = lines(value, text_face, middle)
                except ValueError:
                    trial = None
                if trial is not None and len(trial) <= len(best):
                    high = middle
                else:
                    low = middle + 1
            return lines(value, text_face, high)

        def write(x, y, value, text_face, color, width, leading=1.55, balance=False):
            for text_line in (balanced if balance else lines)(value, text_face, width):
                put(x, y, text_line, text_face, color)
                y += round(text_face.size * leading)
            return y

        def text_height(value, text_face, width, leading=1.55):
            return len(lines(value, text_face, width)) * round(text_face.size * leading)

        def paragraph(x, y, value, text_face, color, width):
            return write(x, y, value, text_face, color, width, balance=True)

        def ink_box(text, display_face):
            return draw.textbbox((0, 0), text, font=display_face, anchor="ls")

        def numerals(x, top, text, size, color, max_width=None):
            """Latin numerals placed by their ink box; returns the ink bottom."""
            while max_width and size > 96 and ink_box(text, face(size, "display"))[2] > max_width:
                size -= 8
            display_face = face(size, "display")
            left, ink_top, _, ink_bottom = ink_box(text, display_face)
            if paint:
                draw.text((x - left, top - ink_top), text, font=display_face, fill=color, anchor="ls")
            return top + ink_bottom - ink_top

        # Signal hero: product, oversized version, and the release's lead feature.
        y = 64
        tag_face = face(30, "bold")
        put(right, y, "版本更新", tag_face, p["ink"], anchor="rt")
        y = write(margin, y, product, tag_face, p["ink"], content_width - measure("版本更新", tag_face) - 40, 1.35)
        y = numerals(margin, y + 48, spec["version"], 400, p["ink"], content_width) + 72
        rect((margin, y, right, y + 3), fill=p["ink"])
        y += 44
        if features:
            lead = features[0]
            number_bottom = numerals(margin, y + 8, "01", 72, p["ink"])
            put(margin, number_bottom + 16, "本版重点", face(26, "bold"), p["ink"])
            text_end = write(body_x, y, lead["title"], face(64, "heavy"), p["ink"], body_width, 1.25)
            text_end = paragraph(body_x, text_end + 18, lead["body"], face(36), p["ink"], body_width)
            y = max(text_end, number_bottom + 16 + 40)
        else:
            y = write(margin, y, f"本版为修复更新 · {len(fixes)} 项修复", face(44, "heavy"), p["ink"], content_width, 1.3)
        y += 72
        bands.append((0, y, p["signal"]))

        # Paper: the remaining features, then secondary changes as plain panels.
        paper_top = y
        if len(features) > 1:
            y += 88
            span = "02" if len(features) == 2 else f"02—{len(features):02d}"
            span_width = ink_box(span, face(32, "display"))[2]
            numerals(right - span_width, y + 30, span, 32, p["accent_ink"])
            y = write(margin, y, "新增与改进", face(64, "heavy"), p["ink"], content_width - span_width - 40, 1.3)
            for index, item in enumerate(features[1:], 2):
                y += 40
                rect((margin, y, right, y + 2), fill=p["ink"])
                y += 32
                number_bottom = numerals(margin, y + 6, f"{index:02d}", 88, p["accent_ink"])
                text_end = write(body_x, y, item["title"], face(44, "heavy"), p["ink"], body_width, 1.3)
                y = max(paragraph(body_x, text_end + 14, item["body"], face(36), p["body"], body_width), number_bottom)
            y += 24
        if extras:
            y += 72
            inner_x, inner_width = margin + 40, content_width - 80
            label_face, headline_face, body_face = face(26, "bold"), face(40, "heavy"), face(34)
            for index, extra in enumerate(extras):
                height = (
                    40 + text_height(extra["title"], label_face, inner_width, 1.4)
                    + 14 + text_height(extra["headline"], headline_face, inner_width, 1.3)
                    + 14 + text_height(extra["body"], body_face, inner_width) + 36
                )
                rect((margin, y, right - 1, y + height - 1), fill=p["panel"])
                inner_y = write(inner_x, y + 40, extra["title"], label_face, p["accent_ink"], inner_width, 1.4)
                inner_y = write(inner_x, inner_y + 14, extra["headline"], headline_face, p["ink"], inner_width, 1.3)
                paragraph(inner_x, inner_y + 14, extra["body"], body_face, p["body"], inner_width)
                y += height + (24 if index < len(extras) - 1 else 0)
            y += 24
        if y > paper_top:
            y += 72
        bands.append((paper_top, y, p["paper"]))

        # Ink band: fixes, credits, install note and colophon.
        night_top = y
        y += 88
        if fixes:
            y = write(margin, y, "重点修复", face(64, "heavy"), p["night_text"], content_width, 1.3)
            for item in fixes:
                y += 36
                rect((margin, y, right, y), fill=p["night_rule"])
                y += 30
                rect((margin, y + 18, margin + 19, y + 37), fill=p["signal"])
                text_end = write(margin + 56, y, item["title"], face(40, "bold"), p["night_text"], content_width - 56, 1.3)
                y = paragraph(margin + 56, text_end + 12, item["body"], face(36), p["night_body"], content_width - 56)
            y += 88

        if people:
            y = write(margin, y, "感谢社区贡献者", face(64, "heavy"), p["night_text"], content_width, 1.3)
            for person in people:
                y += 36
                if paint:
                    mask = Image.new("L", (96, 96))
                    ImageDraw.Draw(mask).ellipse((0, 0, 95, 95), fill=255)
                    canvas.paste(avatar(person), (margin, y), mask)
                x, width = margin + 124, content_width - 124
                text_end = write(x, y, "@" + person["login"], face(34, "bold"), p["night_text"], width, 1.3)
                text_end = paragraph(x, text_end + 10, person["contribution"], face(34), p["night_body"], width)
                y = max(y + 96, text_end)
            y += 88

        if spec.get("install_note"):
            label_face, note_face = face(30, "heavy"), face(32)
            note_x = margin + 39 + measure("安装提示", label_face) + 32
            note_width = right - 39 - note_x
            height = 32 + max(text_height(spec["install_note"], note_face, note_width), 50) + 32
            rect((margin, y, right, y + height), outline=p["signal"], width=3)
            put(margin + 39, y + 37, "安装提示", label_face, p["signal"])
            paragraph(note_x, y + 32, spec["install_note"], note_face, p["night_text"], note_width)
            y += height + 88

        rect((margin, y, right, y + 2), fill=p["night_text"])
        y += 30
        name_face, version_face, url_face = face(28, "bold"), face(28, "display"), face(28)
        row_step = 42
        url = spec.get("footer_url") or ""
        name_lines = lines(product, name_face, content_width)
        version_width = ink_box(spec["version"], version_face)[2]
        tail = measure(name_lines[-1], name_face) + 14 + version_width
        if tail > content_width:
            name_lines.append("")
            tail = version_width
        for index, text_line in enumerate(name_lines):
            put(margin, y + index * row_step, text_line, name_face, p["night_text"])
        last_y = y + (len(name_lines) - 1) * row_step
        baseline = last_y + draw.textbbox((0, 0), "0", font=name_face, anchor="lt")[3]
        if paint:
            draw.text((margin + tail - version_width, baseline), spec["version"], font=version_face, fill=p["signal"], anchor="ls")
        y = last_y + row_step
        if url and len(name_lines) == 1 and tail + 48 + measure(url, url_face) <= content_width:
            put(right, last_y, url, url_face, p["night_body"], anchor="rt")
        elif url:
            y = write(margin, y + 8, url, url_face, p["night_body"], content_width, 1.5)
        y += 64
        bands.append((night_top, y, p["ink"]))
        return y, bands

    canvas = Image.new("RGB", (POSTER_WIDTH, MAX_POSTER_HEIGHT), p["paper"])
    height, bands = layout(canvas, paint=False)
    if height > MAX_POSTER_HEIGHT:
        raise ValueError(f"海报高度 {height}px 超出上限，请减少内容")
    background = ImageDraw.Draw(canvas)
    for top, bottom, color in bands:
        if bottom > top:
            background.rectangle((0, top, POSTER_WIDTH - 1, bottom - 1), fill=color)
    layout(canvas, paint=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.crop((0, 0, POSTER_WIDTH, height)).save(output, optimize=True)
    return (POSTER_WIDTH, height)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    scan_cmd = commands.add_parser("scan", help="查找最新 release note，并输出中文内容与署名候选")
    scan_cmd.add_argument("--repo", type=Path, default=Path.cwd())
    scan_cmd.add_argument("--version", help="指定旧版本进行复测，例如 0.6.6；默认选最新版本")
    scan_cmd.add_argument("--out", type=Path, required=True)
    render_cmd = commands.add_parser("render", help="从经过审核的 JSON 绘制微信群长图")
    render_cmd.add_argument("--scan", type=Path, required=True)
    render_cmd.add_argument("--spec", type=Path, required=True)
    render_cmd.add_argument("--out", type=Path, required=True)
    render_cmd.add_argument("--allow-offline-avatars", action="store_true", help="仅测试用：允许 avatar_path 跳过 GitHub 请求")
    args = parser.parse_args()
    try:
        if args.command == "scan":
            data = scan(args.repo.resolve(), args.version)
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            credited = sum(mention["credit_candidate"] for mention in data["mentions"])
            print(f"v{data['version']} | {data['source']}:{data['path']} | {credited} credits / {len(data['mentions'])} mentions | {args.out}")
        else:
            scan_data = json.loads(args.scan.read_text(encoding="utf-8"))
            spec = json.loads(args.spec.read_text(encoding="utf-8"))
            width, height = render(spec, scan_data, args.spec, args.out, args.allow_offline_avatars)
            print(f"{args.out} | {width}x{height}")
    except (ValueError, RuntimeError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
