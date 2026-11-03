from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
XWD_HEADER_WORDS = 25
XWD_HEADER_BYTES = XWD_HEADER_WORDS * 4
XWD_COLOR_BYTES = 12
CHANNEL_DELTA = 6

PNG_GRAY = 0
PNG_RGB = 2
PNG_PALETTE = 3
PNG_GRAY_ALPHA = 4
PNG_RGBA = 6


@dataclass
class Image:
    width: int
    height: int
    rgb: bytes

    def pixel(self, x: int, y: int) -> tuple[int, int, int]:
        offset = (y * self.width + x) * 3
        return tuple(self.rgb[offset : offset + 3])

    def crop(self, region: tuple[int, int, int, int]) -> "Image":
        x, y, width, height = region
        rows = []
        for row in range(y, y + height):
            start = (row * self.width + x) * 3
            rows.append(self.rgb[start : start + width * 3])
        return Image(width=width, height=height, rgb=b"".join(rows))


def _checked(image: Image) -> Image:
    if image.width <= 0 or image.height <= 0:
        raise ValueError("image dimensions must be positive")
    expected = image.width * image.height * 3
    if len(image.rgb) != expected:
        raise ValueError(f"image carries {len(image.rgb)} bytes, expected {expected}")
    return image


def _xwd_header(data: bytes) -> tuple[int, ...]:
    if len(data) < XWD_HEADER_BYTES:
        raise ValueError("xwd data is shorter than its header")
    return struct.unpack(">25I", data[:XWD_HEADER_BYTES])


def _scale(value: int, mask: int) -> int:
    shift = (mask & -mask).bit_length() - 1
    maximum = mask >> shift
    if maximum == 0:
        return 0
    return round(((value & mask) >> shift) * 255 / maximum)


def _xwd_colormap(data: bytes, offset: int, count: int) -> dict[int, tuple[int, int, int]]:
    table: dict[int, tuple[int, int, int]] = {}
    for index in range(count):
        start = offset + index * XWD_COLOR_BYTES
        entry = data[start : start + XWD_COLOR_BYTES]
        if len(entry) < XWD_COLOR_BYTES:
            raise ValueError("xwd colormap is truncated")
        pixel, red, green, blue = struct.unpack(">IHHH", entry[:10])
        table[pixel] = (red * 255 // 65535, green * 255 // 65535, blue * 255 // 65535)
    return table


def _packed_pixel(row: bytes, index: int, byte_width: int, big_endian: bool) -> int:
    chunk = row[index * byte_width : (index + 1) * byte_width]
    if len(chunk) != byte_width:
        raise ValueError("xwd pixel row is truncated")
    return int.from_bytes(chunk, "big" if big_endian else "little")


def decode_xwd(data: bytes) -> Image:
    header = _xwd_header(data)
    header_size = header[0]
    width = header[4]
    height = header[5]
    byte_order = header[7]
    bits_per_pixel = header[11]
    bytes_per_line = header[12]
    red_mask = header[14]
    green_mask = header[15]
    blue_mask = header[16]
    ncolors = header[19]
    if header_size < XWD_HEADER_BYTES:
        raise ValueError("xwd header size is invalid")
    if bits_per_pixel not in (8, 16, 24, 32):
        raise ValueError(f"unsupported xwd bits per pixel {bits_per_pixel}")
    byte_width = (bits_per_pixel + 7) // 8
    if bytes_per_line < byte_width * width:
        raise ValueError("xwd stride is shorter than a row")
    colors = _xwd_colormap(data, header_size, ncolors) if ncolors else {}
    start = header_size + ncolors * XWD_COLOR_BYTES
    big_endian = byte_order == 1
    pixels = bytearray()
    for y in range(height):
        row_start = start + y * bytes_per_line
        row = data[row_start : row_start + bytes_per_line]
        if len(row) < bytes_per_line:
            raise ValueError("xwd pixel data is truncated")
        for x in range(width):
            value = _packed_pixel(row, x, byte_width, big_endian)
            if colors and header[13] != 4:
                red, green, blue = colors.get(value, (0, 0, 0))
            elif red_mask or green_mask or blue_mask:
                red = _scale(value, red_mask)
                green = _scale(value, green_mask)
                blue = _scale(value, blue_mask)
            else:
                level = value & 0xFF
                red = green = blue = level
            pixels.extend((red, green, blue))
    return _checked(Image(width=width, height=height, rgb=bytes(pixels)))


def _unfilter(raw: bytes, width: int, height: int, channels: int, bit_depth: int) -> list[bytes]:
    bytes_per_pixel = max(1, (channels * bit_depth + 7) // 8)
    stride = (width * channels * bit_depth + 7) // 8
    rows: list[bytes] = []
    previous = bytearray(stride)
    position = 0
    for _ in range(height):
        if position >= len(raw):
            raise ValueError("png image data is truncated")
        filter_type = raw[position]
        position += 1
        row = bytearray(raw[position : position + stride])
        position += stride
        if len(row) != stride:
            raise ValueError("png scanline is truncated")
        if filter_type == 1:
            for index in range(bytes_per_pixel, stride):
                row[index] = (row[index] + row[index - bytes_per_pixel]) & 0xFF
        elif filter_type == 2:
            for index in range(stride):
                row[index] = (row[index] + previous[index]) & 0xFF
        elif filter_type == 3:
            for index in range(stride):
                left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                row[index] = (row[index] + ((left + previous[index]) // 2)) & 0xFF
        elif filter_type == 4:
            for index in range(stride):
                left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                up = previous[index]
                up_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                estimate = left + up - up_left
                pa = abs(estimate - left)
                pb = abs(estimate - up)
                pc = abs(estimate - up_left)
                predictor = left if pa <= pb and pa <= pc else (up if pb <= pc else up_left)
                row[index] = (row[index] + predictor) & 0xFF
        elif filter_type != 0:
            raise ValueError(f"unknown png filter {filter_type}")
        rows.append(bytes(row))
        previous = row
    return rows


def _png_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("png signature is missing")
    chunks = []
    position = len(PNG_SIGNATURE)
    while position + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[position : position + 8])
        position += 8
        body = data[position : position + length]
        if len(body) != length or position + length + 4 > len(data):
            raise ValueError("png chunk is truncated")
        position += length
        stored = struct.unpack(">I", data[position : position + 4])[0]
        position += 4
        actual = zlib.crc32(kind + body) & 0xFFFFFFFF
        if stored != actual:
            raise ValueError(f"png chunk {kind!r} failed its crc")
        chunks.append((kind, body))
        if kind == b"IEND":
            break
    return chunks


def decode_png(data: bytes) -> Image:
    chunks = _png_chunks(data)
    header = None
    palette = b""
    compressed = bytearray()
    for kind, body in chunks:
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = body
        elif kind == b"IDAT":
            compressed.extend(body)
    if header is None:
        raise ValueError("png has no header chunk")
    width, height, bit_depth, color_type, compression, filter_method, interlace = header
    if compression != 0 or filter_method != 0:
        raise ValueError("png uses an unsupported compression or filter method")
    if interlace != 0:
        raise ValueError("interlaced png is not supported")
    if bit_depth not in (8, 16):
        raise ValueError(f"unsupported png bit depth {bit_depth}")
    channels = {
        PNG_GRAY: 1,
        PNG_RGB: 3,
        PNG_PALETTE: 1,
        PNG_GRAY_ALPHA: 2,
        PNG_RGBA: 4,
    }.get(color_type)
    if channels is None:
        raise ValueError(f"unsupported png color type {color_type}")
    sample_bytes = 2 if bit_depth == 16 else 1
    raw = zlib.decompress(bytes(compressed))
    rows = _unfilter(raw, width, height, channels, bit_depth)
    pixels = bytearray()
    for row in rows:
        if color_type == PNG_PALETTE:
            for index in range(width):
                entry = row[index] * 3
                if entry + 3 > len(palette):
                    raise ValueError("png palette index is out of range")
                pixels.extend(palette[entry : entry + 3])
            continue
        for index in range(width):
            base = index * channels * sample_bytes
            if color_type == PNG_GRAY:
                level = row[base]
                pixels.extend((level, level, level))
            elif color_type == PNG_GRAY_ALPHA:
                level = row[base]
                pixels.extend((level, level, level))
            else:
                pixels.extend(row[base : base + 3])
    return _checked(Image(width=width, height=height, rgb=bytes(pixels)))


def _region_of(image: Image, region: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x, y, width, height = region
    if width <= 0 or height <= 0:
        raise ValueError("region must have positive size")
    if x < 0 or y < 0 or x + width > image.width or y + height > image.height:
        raise ValueError("region lies outside the image")
    return region


def mismatch_fraction(
    a: Image,
    b: Image,
    region: tuple[int, int, int, int] | None = None,
) -> float:
    if region is None:
        if (a.width, a.height) != (b.width, b.height):
            raise ValueError("images have different dimensions")
        region = (0, 0, a.width, a.height)
    _region_of(a, region)
    _region_of(b, region)
    x, y, width, height = region
    differing = 0
    for row in range(y, y + height):
        for column in range(x, x + width):
            first = a.pixel(column, row)
            second = b.pixel(column, row)
            if max(abs(left - right) for left, right in zip(first, second)) > CHANNEL_DELTA:
                differing += 1
    return differing / (width * height)


def similar(
    a: Image,
    b: Image,
    region: tuple[int, int, int, int] | None = None,
    *,
    tolerance: float = 0.02,
) -> bool:
    if (a.width, a.height) != (b.width, b.height):
        if region is None:
            return False
        _region_of(a, region)
        _region_of(b, region)
    return mismatch_fraction(a, b, region) <= tolerance


def solid(width: int, height: int, color: tuple[int, int, int]) -> Image:
    return Image(width=width, height=height, rgb=bytes(color) * (width * height))


def encode_png(image: Image) -> bytes:
    _checked(image)
    header = struct.pack(">IIBBBBB", image.width, image.height, 8, PNG_RGB, 0, 0, 0)
    rows = bytearray()
    for y in range(image.height):
        rows.append(0)
        start = y * image.width * 3
        rows.extend(image.rgb[start : start + image.width * 3])
    return (
        PNG_SIGNATURE
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(bytes(rows)))
        + _png_chunk(b"IEND", b"")
    )


def _png_chunk(kind: bytes, body: bytes) -> bytes:
    return (
        struct.pack(">I", len(body))
        + kind
        + body
        + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    )
