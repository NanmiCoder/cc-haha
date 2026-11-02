import struct
import unittest
import zlib

from oracle import pixels


def _header(width, height, bits, stride, red, green, blue, byte_order=0, ncolors=0):
    words = [
        100,
        7,
        2,
        bits,
        width,
        height,
        0,
        byte_order,
        32,
        0,
        32,
        bits,
        stride,
        4,
        red,
        green,
        blue,
        8,
        ncolors,
        ncolors,
        width,
        height,
        0,
        0,
        0,
    ]
    return struct.pack(">25I", *words)


def _xwd_24(width, height, rows, stride):
    body = b"".join(row + b"\x00" * (stride - len(row)) for row in rows)
    return _header(width, height, 24, stride, 0xFF0000, 0x00FF00, 0x0000FF) + body


def _chunk(kind, body):
    return (
        struct.pack(">I", len(body))
        + kind
        + body
        + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    )


def _png(width, height, color_type, rows, extra=b""):
    header = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    raw = b"".join(b"\x00" + row for row in rows)
    return (
        pixels.PNG_SIGNATURE
        + _chunk(b"IHDR", header)
        + extra
        + _chunk(b"IDAT", zlib.compress(raw))
        + _chunk(b"IEND", b"")
    )


class XwdDecodeTests(unittest.TestCase):
    def test_truecolor_uses_masks_even_when_xwd_contains_color_records(self):
        header = _header(1, 1, 32, 4, 0xFF0000, 0x00FF00, 0x0000FF, ncolors=1)
        color = struct.pack(">IHHHBB", 0, 65535, 65535, 65535, 7, 0)
        image = pixels.decode_xwd(header + color + struct.pack("<I", 0x00112233))
        self.assertEqual(image.pixel(0, 0), (0x11, 0x22, 0x33))

    def test_24_bit_rows_honour_stride(self):
        rows = [b"\x03\x02\x01" + b"\xff\xff", b"\x06\x05\x04" + b"\xff\xff"]
        image = pixels.decode_xwd(_xwd_24(1, 2, rows, 5))
        self.assertEqual(image.width, 1)
        self.assertEqual(image.height, 2)
        self.assertEqual(image.pixel(0, 0), (1, 2, 3))
        self.assertEqual(image.pixel(0, 1), (4, 5, 6))

    def test_a_stride_read_as_pixels_is_rejected(self):
        rows = [b"\x03\x02\x01" + b"\xff\xff", b"\x06\x05\x04" + b"\xff\xff"]
        data = _xwd_24(2, 2, rows, 5)
        with self.assertRaises(ValueError):
            pixels.decode_xwd(data)

    def test_32_bit_little_endian_masks(self):
        body = struct.pack("<I", 0x00FF0000) + struct.pack("<I", 0x0000FF00)
        header = _header(2, 1, 32, 8, 0xFF0000, 0x00FF00, 0x0000FF)
        image = pixels.decode_xwd(header + body)
        self.assertEqual(image.pixel(0, 0), (255, 0, 0))
        self.assertEqual(image.pixel(1, 0), (0, 255, 0))

    def test_truncated_data_is_rejected(self):
        data = _xwd_24(2, 2, [b"\x00\x00\x00"], 6)
        with self.assertRaises(ValueError):
            pixels.decode_xwd(data)


class PngDecodeTests(unittest.TestCase):
    def test_rgb_png_decodes(self):
        data = _png(2, 1, 2, [b"\xff\x00\x00\x00\xff\x00"])
        image = pixels.decode_png(data)
        self.assertEqual(image.pixel(0, 0), (255, 0, 0))
        self.assertEqual(image.pixel(1, 0), (0, 255, 0))

    def test_rgba_png_drops_alpha(self):
        data = _png(1, 1, 6, [b"\x01\x02\x03\x04"])
        self.assertEqual(pixels.decode_png(data).pixel(0, 0), (1, 2, 3))

    def test_palette_png_decodes(self):
        table = _chunk(b"PLTE", b"\x10\x20\x30\x40\x50\x60")
        data = _png(2, 1, 3, [b"\x00\x01"], table)
        image = pixels.decode_png(data)
        self.assertEqual(image.pixel(0, 0), (0x10, 0x20, 0x30))
        self.assertEqual(image.pixel(1, 0), (0x40, 0x50, 0x60))

    def test_wrong_crc_is_rejected(self):
        data = bytearray(_png(1, 1, 2, [b"\x01\x02\x03"]))
        data[-5] ^= 0xFF
        with self.assertRaises(ValueError):
            pixels.decode_png(bytes(data))

    def test_missing_signature_is_rejected(self):
        with self.assertRaises(ValueError):
            pixels.decode_png(b"not a png")


class SimilarityTests(unittest.TestCase):
    def test_identical_images_compare_equal(self):
        image = pixels.solid(4, 4, (10, 20, 30))
        self.assertTrue(pixels.similar(image, image))

    def test_a_changed_region_moves_the_comparison(self):
        first = pixels.solid(4, 4, (0, 0, 0))
        changed = bytearray(first.rgb)
        changed[(2 * 4 + 2) * 3 : (2 * 4 + 2) * 3 + 3] = b"\xff\xff\xff"
        second = pixels.Image(width=4, height=4, rgb=bytes(changed))
        self.assertTrue(pixels.similar(first, second, (0, 0, 2, 2)))
        self.assertFalse(pixels.similar(first, second, (2, 2, 1, 1)))

    def test_different_dimensions_do_not_compare_equal(self):
        self.assertFalse(pixels.similar(pixels.solid(2, 2, (0, 0, 0)), pixels.solid(3, 2, (0, 0, 0))))

    def test_tolerance_is_the_differing_fraction(self):
        first = pixels.solid(10, 10, (0, 0, 0))
        changed = bytearray(first.rgb)
        changed[0:3] = b"\xff\xff\xff"
        second = pixels.Image(width=10, height=10, rgb=bytes(changed))
        self.assertTrue(pixels.similar(first, second, tolerance=0.02))
        self.assertFalse(pixels.similar(first, second, tolerance=0.001))

    def test_region_outside_the_image_is_rejected(self):
        image = pixels.solid(4, 4, (0, 0, 0))
        with self.assertRaises(ValueError):
            pixels.similar(image, image, (3, 3, 2, 2))


if __name__ == "__main__":
    unittest.main()
