#!/usr/bin/env python3
"""Render the action-sheet reference image shown in the custom pet wizard.

The grid mirrors PET_SOURCE_SHEET_LAYOUT in
desktop/src/features/pets/petAtlasNormalize.ts: authors draw nine rows and the app
expands them into the eleven-row v2 atlas (mirroring the run row, reusing the work
row, and filling the neutral look frame).

Usage:
    python3 desktop/scripts/build-pet-sheet-guide.py
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CELL_WIDTH = 192
CELL_HEIGHT = 208
COLUMNS = 8
ROWS = 9

LABEL_WIDTH = 316
HEADER_HEIGHT = 196
FOOTER_HEIGHT = 168
MARGIN_RIGHT = 40

CANVAS_BG = (250, 247, 242, 255)
GRID_LINE = (216, 206, 193, 255)
CELL_ACTIVE = (255, 255, 255, 255)
CELL_UNUSED = (240, 235, 227, 255)
TEXT_PRIMARY = (46, 42, 38, 255)
TEXT_SECONDARY = (107, 99, 90, 255)
TEXT_FAINT = (168, 158, 146, 255)
ACCENT = (181, 86, 58, 255)
SAFE_AREA = (204, 190, 174, 255)

FONT_CANDIDATES = (
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
)

# (row label, frame count, what to draw)
ROWS_EN = [
    ("Idle", 6, "Standing still with a gentle breathing bob"),
    ("Run right", 8, "Full run cycle, must face right (left is mirrored for you)"),
    ("Wave", 4, "Raise a hand and greet"),
    ("Jump", 5, "Crouch, leap, land"),
    ("Fail", 8, "Discouraged, head down, sighing"),
    ("Wait", 6, "Looking around, shifting in place"),
    ("Work", 6, "Head down, busy typing or tinkering"),
    ("Look upper half", 8, "Start facing straight up, turn 22.5° clockwise per cell"),
    ("Look lower half", 8, "Continue from straight down back toward straight up"),
]

TEXT_EN = {
    "title": "Pet action sheet - 8 columns x 9 rows",
    "subtitle": "192 x 208 px per cell, 1536 x 1872 overall. Transparent PNG. The size does not have to match exactly; a close ratio is fine and the app rescales on import.",
    "column_hint": "<- frames run left to right within each row ->",
    "footer": [
        "- Transparent background is required: a white or coloured backdrop becomes a square on your desktop.",
        "- Centre the character in each cell, feet a little below the middle, with a small margin all round.",
        "- All nine rows must be the same character, same art style, same proportions - only the pose changes.",
        "- Too much work? Repeat the first idle frame for the last two rows: the pet simply will not track your cursor.",
    ],
    "unused": "leave empty",
    "safe": "draw here",
    "frames": "{count} frames",
}


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        path = Path(candidate)
        if not path.exists():
            continue
        try:
            # Hiragino Sans GB ships W3 (index 0) and W6 (index 1).
            return ImageFont.truetype(candidate, size, index=1 if bold else 0)
        except OSError:
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_dashed_rect(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    colour: tuple[int, int, int, int],
    dash: int = 8,
    gap: int = 7,
) -> None:
    left, top, right, bottom = box
    for x in range(left, right, dash + gap):
        draw.line([(x, top), (min(x + dash, right), top)], fill=colour)
        draw.line([(x, bottom), (min(x + dash, right), bottom)], fill=colour)
    for y in range(top, bottom, dash + gap):
        draw.line([(left, y), (left, min(y + dash, bottom))], fill=colour)
        draw.line([(right, y), (right, min(y + dash, bottom))], fill=colour)


def render(rows: list[tuple[str, int, str]], text: dict, output: Path) -> None:
    width = LABEL_WIDTH + COLUMNS * CELL_WIDTH + MARGIN_RIGHT
    height = HEADER_HEIGHT + ROWS * CELL_HEIGHT + FOOTER_HEIGHT
    image = Image.new("RGBA", (width, height), CANVAS_BG)
    draw = ImageDraw.Draw(image)

    font_title = load_font(46, bold=True)
    font_subtitle = load_font(23)
    font_row = load_font(31, bold=True)
    font_row_note = load_font(20)
    font_badge = load_font(21, bold=True)
    font_cell = load_font(19)
    font_footer = load_font(22)

    draw.text((48, 44), text["title"], font=font_title, fill=TEXT_PRIMARY)
    subtitle_y = 108
    for line in wrap_text(draw, text["subtitle"], font_subtitle, width - 96):
        draw.text((48, subtitle_y), line, font=font_subtitle, fill=TEXT_SECONDARY)
        subtitle_y += 30

    grid_left = LABEL_WIDTH
    grid_top = HEADER_HEIGHT

    draw.text(
        (grid_left, grid_top - 34),
        text["column_hint"],
        font=font_row_note,
        fill=TEXT_FAINT,
    )

    for row_index, (name, frame_count, note) in enumerate(rows):
        top = grid_top + row_index * CELL_HEIGHT

        badge_size = 34
        draw.ellipse(
            [(48, top + 22), (48 + badge_size, top + 22 + badge_size)],
            fill=ACCENT,
        )
        badge_text = str(row_index + 1)
        badge_box = draw.textbbox((0, 0), badge_text, font=font_badge)
        draw.text(
            (
                48 + (badge_size - (badge_box[2] - badge_box[0])) / 2 - badge_box[0],
                top + 22 + (badge_size - (badge_box[3] - badge_box[1])) / 2 - badge_box[1],
            ),
            badge_text,
            font=font_badge,
            fill=(255, 255, 255, 255),
        )

        draw.text((96, top + 20), name, font=font_row, fill=TEXT_PRIMARY)
        draw.text(
            (96, top + 58),
            text["frames"].format(count=frame_count),
            font=font_row_note,
            fill=ACCENT,
        )
        note_y = top + 88
        for line in wrap_text(draw, note, font_row_note, LABEL_WIDTH - 112):
            draw.text((96, note_y), line, font=font_row_note, fill=TEXT_SECONDARY)
            note_y += 26

        for column in range(COLUMNS):
            left = grid_left + column * CELL_WIDTH
            box = [(left, top), (left + CELL_WIDTH, top + CELL_HEIGHT)]
            used = column < frame_count
            draw.rectangle(box, fill=CELL_ACTIVE if used else CELL_UNUSED, outline=GRID_LINE)

            if used:
                label = f"{column + 1}"
                draw.text((left + 10, top + 8), label, font=font_cell, fill=TEXT_FAINT)
                if row_index == 0 and column == 0:
                    inset_x, inset_y = 26, 18
                    draw_dashed_rect(
                        draw,
                        (
                            left + inset_x,
                            top + inset_y,
                            left + CELL_WIDTH - inset_x,
                            top + CELL_HEIGHT - inset_y,
                        ),
                        SAFE_AREA,
                    )
                    hint_box = draw.textbbox((0, 0), text["safe"], font=font_cell)
                    draw.text(
                        (
                            left + (CELL_WIDTH - (hint_box[2] - hint_box[0])) / 2,
                            top + CELL_HEIGHT / 2 - 12,
                        ),
                        text["safe"],
                        font=font_cell,
                        fill=SAFE_AREA,
                    )
            else:
                hint_box = draw.textbbox((0, 0), text["unused"], font=font_cell)
                draw.text(
                    (
                        left + (CELL_WIDTH - (hint_box[2] - hint_box[0])) / 2,
                        top + CELL_HEIGHT / 2 - 12,
                    ),
                    text["unused"],
                    font=font_cell,
                    fill=TEXT_FAINT,
                )

    footer_y = grid_top + ROWS * CELL_HEIGHT + 28
    for line in text["footer"]:
        draw.text((48, footer_y), line, font=font_footer, fill=TEXT_SECONDARY)
        footer_y += 33

    output.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(output, "PNG", optimize=True)
    print(f"wrote {output} ({image.width}x{image.height})")


def wrap_text(
    draw: ImageDraw.ImageDraw,
    content: str,
    font: ImageFont.FreeTypeFont,
    max_width: int,
) -> list[str]:
    """Wraps on spaces for latin text and per character for CJK."""
    if not content:
        return []
    words = content.split(" ")
    use_words = len(words) > 3
    tokens = words if use_words else list(content)
    joiner = " " if use_words else ""
    lines: list[str] = []
    current = ""
    for token in tokens:
        candidate = f"{current}{joiner}{token}" if current else token
        if draw.textlength(candidate, font=font) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            current = token
    if current:
        lines.append(current)
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "src" / "assets" / "pets",
    )
    args = parser.parse_args()

    render(ROWS_EN, TEXT_EN, args.out_dir / "action-sheet-guide.en.png")


if __name__ == "__main__":
    main()
