from io import BytesIO
import unittest

import numpy as np
from PIL import Image, ImageDraw

from backend.detection import ImageError, Options, detect_image


def encode(image, format="PNG", **kwargs):
    with BytesIO() as data:
        image.save(data, format=format, **kwargs)
        return data.getvalue()


def rice_scene(shadow=None):
    image = Image.new("RGB", (800, 600), "white")
    draw = ImageDraw.Draw(image)
    positions = [(x, y) for y in [100, 220, 340, 460] for x in [100, 240, 380, 520, 660]]
    for x, y in positions:
        draw.ellipse((x - 14, y - 30, x + 14, y + 30), fill=(184, 144, 60))
    if shadow:
        pixels = np.asarray(image).astype(float)
        yy, xx = np.mgrid[:600, :800]
        if shadow == "smooth":
            illumination = 1 - 0.55 * np.exp(-((xx - 400) ** 2 / 90000 + (yy - 280) ** 2 / 100000))
        else:
            illumination = np.where(xx > 410, 0.48, 1.0)
        image = Image.fromarray((pixels * illumination[:, :, None]).astype(np.uint8))
    return image, positions


class DetectionTests(unittest.TestCase):
    def test_separated_seeds_have_one_dot_each(self):
        image, positions = rice_scene()
        result = detect_image(encode(image))
        self.assertEqual(result["count"], len(positions))
        for point, (x, y) in zip(result["points"], positions):
            self.assertLess(abs(point["x"] - x), 2)
            self.assertLess(abs(point["y"] - y), 2)

    def test_white_paper_with_smooth_shadow(self):
        image, positions = rice_scene("smooth")
        result = detect_image(encode(image))
        self.assertEqual(result["count"], len(positions))

    def test_white_paper_with_hard_shadow(self):
        image, positions = rice_scene("hard")
        result = detect_image(encode(image))
        self.assertEqual(result["count"], len(positions))

    def test_empty_paper_and_empty_shadow_are_zero(self):
        for shade in [255, 120]:
            with self.subTest(shade=shade):
                image = Image.new("RGB", (600, 400), (shade, shade, shade))
                self.assertEqual(detect_image(encode(image))["count"], 0)
        yy, xx = np.mgrid[:400, :600]
        gray = (255 * (1 - .5 * np.exp(-((xx - 300) ** 2 + (yy - 200) ** 2) / 50000))).astype(np.uint8)
        image = Image.fromarray(np.repeat(gray[:, :, None], 3, axis=2))
        self.assertEqual(detect_image(encode(image))["count"], 0)

    def test_dark_background(self):
        image = Image.new("RGB", (400, 300), (15, 15, 15))
        draw = ImageDraw.Draw(image)
        for x in [80, 180, 280]:
            draw.ellipse((x - 10, 80, x + 10, 140), fill=(215, 185, 98))
        self.assertEqual(detect_image(encode(image), Options(background="dark"))["count"], 3)

    def test_touching_pair_and_split_off(self):
        image = Image.new("RGB", (400, 300), "white")
        draw = ImageDraw.Draw(image)
        draw.ellipse((125, 80, 165, 180), fill=(184, 144, 60))
        draw.ellipse((160, 120, 200, 220), fill=(184, 144, 60))
        result = detect_image(encode(image))
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["review_count"], 2)
        self.assertEqual(detect_image(encode(image), Options(split="off"))["count"], 1)

    def test_parallel_touching_triple_with_same_photo_size_reference(self):
        # Shape-only gating used to return one for this nearly convex cluster.
        image = Image.new("RGB", (500, 400), "white")
        draw = ImageDraw.Draw(image)
        for x in [60, 140, 220, 300]:
            draw.ellipse((x - 20, 40, x + 20, 140), fill=(184, 144, 60))
        for index in range(3):
            draw.ellipse((180 + index * 26, 180, 220 + index * 26, 280), fill=(184, 144, 60))
        for source in (image, image.rotate(90, expand=True)):
            result = detect_image(encode(source))
            self.assertEqual(result["count"], 7)
            self.assertEqual(result["review_count"], 3)
            self.assertEqual(detect_image(encode(source), Options(split="off"))["count"], 5)

    def test_black_and_warm_grains_in_shadow(self):
        image, positions = rice_scene()
        draw = ImageDraw.Draw(image)
        for x, y in positions[::2]:
            draw.ellipse((x - 14, y - 30, x + 14, y + 30), fill=(27, 27, 27))
        pixels = np.asarray(image).astype(float)
        yy, xx = np.mgrid[:600, :800]
        shade = 1 - 0.5 * np.exp(-((xx - 400) ** 2 + (yy - 300) ** 2) / 90000)
        image = Image.fromarray((pixels * shade[:, :, None]).astype(np.uint8))
        result = detect_image(encode(image))
        self.assertEqual(result["count"], len(positions))

    def test_large_single_grain_is_not_split_by_area_alone(self):
        image, _ = rice_scene()
        ImageDraw.Draw(image).ellipse((700, 500, 770, 580), fill=(27, 27, 27))
        self.assertEqual(detect_image(encode(image))["count"], 21)

    def test_selected_range_excludes_outside_and_keeps_original_coordinates(self):
        image, positions = rice_scene()
        result = detect_image(encode(image), Options(roi=(.25, 0, .75, 1)))
        self.assertEqual((result["width"], result["height"]), (800, 600))
        self.assertEqual(result["count"], 12)
        self.assertTrue(all(200 <= point["x"] <= 600 for point in result["points"]))
        for point in result["points"]:
            self.assertLess(min(abs(point["x"] - x) + abs(point["y"] - y) for x, y in positions), 3)
        self.assertEqual(result["roi"], [.25, 0, .75, 1])

    def test_selected_range_rejects_empty_invalid_and_tiny(self):
        image, _ = rice_scene()
        for roi in [(0, 0, 0, 1), (0, 0, 2, 1), (0, 0, .001, .001), (0, 0, float("nan"), 1)]:
            with self.subTest(roi=roi), self.assertRaises(ImageError):
                detect_image(encode(image), Options(roi=roi))

    def test_exif_rotation_uses_oriented_coordinates(self):
        image = Image.new("RGB", (400, 300), "white")
        ImageDraw.Draw(image).ellipse((80, 30, 100, 90), fill=(184, 144, 60))
        exif = Image.Exif(); exif[274] = 6
        result = detect_image(encode(image, "JPEG", exif=exif))
        self.assertEqual((result["width"], result["height"]), (300, 400))
        self.assertEqual(result["count"], 1)
        self.assertLess(abs(result["points"][0]["x"] - 239.5), 3)
        self.assertLess(abs(result["points"][0]["y"] - 90.5), 3)

    def test_large_image_returns_original_coordinates(self):
        image = Image.new("RGB", (3000, 1800), "white")
        ImageDraw.Draw(image).ellipse((2300, 900, 2340, 1020), fill=(184, 144, 60))
        result = detect_image(encode(image))
        self.assertEqual(result["working_width"], 2200)
        self.assertEqual(result["count"], 1)
        self.assertLess(abs(result["points"][0]["x"] - 2320), 3)
        self.assertLess(abs(result["points"][0]["y"] - 960), 3)

    def test_corrupt_unsupported_and_oversize_images(self):
        with self.assertRaises(ImageError):
            detect_image(b"not a photo")
        with self.assertRaises(ImageError):
            detect_image(encode(Image.new("RGB", (40, 40)), "GIF"))
        # Construct a valid header reporting excessive pixels without decoding
        # a large allocation. Pillow rejects it at header inspection time.
        image = Image.new("1", (6000, 5000))
        with self.assertRaises(ImageError):
            detect_image(encode(image))

    def test_tiny_noise_is_removed(self):
        image, positions = rice_scene()
        draw = ImageDraw.Draw(image)
        for i in range(40):
            draw.rectangle((20 + i * 18, 570, 21 + i * 18, 571), fill="black")
        self.assertEqual(detect_image(encode(image))["count"], len(positions))


if __name__ == "__main__":
    unittest.main()
