"""CPU seed counting for flat seeds on a uniform contrasting background.

No network calls, file writes, trained weights, or retained image state.
Coordinates always refer to the full-size, EXIF-oriented input image.
"""

from dataclasses import dataclass
from io import BytesIO
import warnings

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from scipy import ndimage as ndi
from scipy.spatial import ConvexHull, QhullError
from scipy.signal import find_peaks
from skimage.segmentation import watershed

MAX_PIXELS = 24_000_000
MAX_SIDE = 2200
MAX_POINTS = 5000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ImageError(ValueError):
    pass


@dataclass(frozen=True)
class Options:
    background: str = "paper"
    sensitivity: float = 0.0
    min_area_percent: float = 0.002
    split: str = "balanced"
    roi: tuple[float, float, float, float] | None = None


def otsu(values: np.ndarray) -> float:
    histogram = np.bincount(values.astype(np.uint8).ravel(), minlength=256).astype(float)
    total = histogram.sum()
    weight = np.cumsum(histogram)
    moment = np.cumsum(histogram * np.arange(256))
    denominator = weight * (total - weight)
    score = np.divide(
        (moment[-1] * weight - moment * total) ** 2,
        denominator,
        out=np.zeros(256),
        where=denominator > 0,
    )
    return float(np.argmax(score))


def foreground(rgb: np.ndarray, options: Options) -> tuple[np.ndarray, list[str]]:
    notes = []
    # Robust border estimate: keep a clear margin around the seeds when shooting.
    rim = max(2, round(min(rgb.shape[:2]) * 0.025))
    border = np.concatenate(
        [rgb[:rim].reshape(-1, 3), rgb[-rim:].reshape(-1, 3),
         rgb[:, :rim].reshape(-1, 3), rgb[:, -rim:].reshape(-1, 3)]
    ).astype(np.float32)
    background = np.median(border, axis=0)
    if np.median(np.linalg.norm(border - background, axis=1)) > 22:
        notes.append("背景颜色不均匀，请重点检查阴影、纹理和照片边缘。")
    pixels = rgb.astype(np.float32)
    paper = options.background == "paper" or (
        options.background == "auto" and background.min() > 120 and np.ptp(background) < 55
    )
    if paper:
        gray = pixels @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        # Closing fills small dark seeds while preserving broad illumination
        # changes. Divide by this locally estimated paper brightness so a gray
        # shadow does not become a foreground object merely for being dark.
        window = max(15, round(min(rgb.shape[:2]) * 0.07) | 1)
        illumination = ndi.grey_closing(gray, size=(window, window))
        illumination = ndi.gaussian_filter(illumination, max(1, window / 12))
        darkness = np.clip(255 * (illumination - gray) / np.maximum(illumination, 25), 0, 255)
        # Rice husks often retain warm color even inside an achromatic shadow.
        chroma = (pixels.max(axis=2) - pixels.min(axis=2)) * 1.3
        # Soft gray shadows adjoining a warm husk should not bridge separate
        # grains. Deep achromatic grains still have strong darkness contrast.
        contrast = np.maximum(darkness * 0.6, chroma).clip(0, 255)
    elif options.background == "auto":
        contrast = np.clip(np.linalg.norm(pixels - background, axis=2), 0, 255)
    else:
        gray = pixels @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        contrast = gray if options.background == "dark" else 255 - gray
    contrast = ndi.median_filter(contrast, size=3)
    # Leave a margin above Otsu's boundary on paper to avoid including the
    # faint edge shadows that form bridges between otherwise separate grains.
    threshold = max(12, otsu(contrast) + (8 if paper else 0) - options.sensitivity)
    mask = contrast > threshold
    mask = ndi.binary_opening(mask, structure=np.ones((3, 3), dtype=bool))
    mask = ndi.binary_fill_holes(mask)
    fraction = float(mask.mean())
    if fraction > 0.45:
        notes.append("前景占比偏高，可能存在堆叠或背景误识别；建议把种子摊开或切换背景模式。")
    return mask, notes


def solidity(region: np.ndarray) -> float:
    edge = region & ~ndi.binary_erosion(region)
    coordinates = np.column_stack(np.nonzero(edge))
    if len(coordinates) < 4:
        return 1.0
    try:
        return min(1.0, float(region.sum()) / max(1.0, ConvexHull(coordinates).volume))
    except QhullError:
        return 1.0


def split_region(region: np.ndarray, mode: str, seed_area: float | None = None) -> tuple[list[np.ndarray], bool]:
    if mode == "off":
        return [region], False
    # Use well separated grains in this same photo as a size reference. A
    # broad group of parallel touching grains can be almost convex, so shape
    # alone must not exclude it from examination. Area alone never sets count.
    oversized = seed_area is not None and region.sum() > seed_area * 1.65
    if seed_area is not None and region.sum() < seed_area * (1.45 if mode == "balanced" else 1.25):
        return [region], solidity(region) < 0.90
    limit = 0.94 if mode == "balanced" else 0.975
    if not oversized and solidity(region) >= limit:
        return [region], False
    distance = ndi.distance_transform_edt(region)
    smooth = ndi.gaussian_filter(distance, 0.8)
    radius = float(distance.max())
    # A large window previously suppressed the nearby centers of parallel
    # touching grains. Relax spacing only when there is a size reference.
    spacing = 1.1 if oversized else (1.8 if mode == "balanced" else 1.2)
    window = max(3, int(radius * spacing) | 1)
    peaks = (smooth == ndi.maximum_filter(smooth, size=window)) & region
    peaks &= smooth > radius * (0.5 if mode == "balanced" else 0.35)
    islands, number = ndi.label(peaks)
    if number < 2:
        if oversized:
            # Parallel touching grains can have only one distance peak. Their
            # outline still has separate bulges. Look for those along both
            # axes, requiring plausible individual areas after partitioning.
            for axis in (0, 1):
                profile = ndi.gaussian_filter1d(region.sum(axis=axis).astype(float), 1.5)
                centers, _ = find_peaks(profile, prominence=profile.max() * 0.12,
                                        distance=max(3, np.sqrt(seed_area) * 0.35))
                if not 2 <= len(centers) <= 12:
                    continue
                cuts = [0, *[(int(a) + int(b)) // 2 for a, b in zip(centers, centers[1:])], len(profile)]
                parts = []
                for left, right in zip(cuts, cuts[1:]):
                    part = np.zeros_like(region)
                    if axis == 0:
                        part[:, left:right] = region[:, left:right]
                    else:
                        part[left:right, :] = region[left:right, :]
                    parts.append(part)
                if all(seed_area * 0.45 <= part.sum() <= seed_area * 1.55 for part in parts):
                    return parts, True
        return [region], True
    if number > 12:
        return [region], True
    markers = np.zeros(region.shape, np.int32)
    for index, position in enumerate(ndi.center_of_mass(peaks, islands, range(1, number + 1)), 1):
        y, x = np.round(position).astype(int)
        if not region[y, x]:
            y, x = np.argwhere(islands == index)[0]
        markers[y, x] = index
    # Masked watershed with FIFO plateau handling prevents a slightly higher
    # distance peak from swallowing the whole touching component.
    labels = watershed(-smooth, markers, mask=region)
    if seed_area is not None:
        # Small watershed fragments were being counted as complete grains.
        # Remove the fragment's marker, then let adjacent regions reclaim it.
        while np.count_nonzero(markers) > 1:
            identifiers = np.unique(markers[markers > 0])
            areas = [(int((labels == index).sum()), index) for index in identifiers]
            area, identifier = min(areas)
            if area >= seed_area * 0.38:
                break
            markers[markers == identifier] = 0
            labels = watershed(-smooth, markers, mask=region)
    parts = [(labels == index) & region for index in range(1, number + 1)]
    parts = [part for part in parts if part.sum() >= max(8, region.sum() * 0.08)]
    if oversized and any(part.sum() < seed_area * 0.28 for part in parts):
        return [region], True
    return (parts if parts else [region]), True


def detect_image(payload: bytes | bytearray, options: Options = Options()) -> dict:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with BytesIO(payload) as stream, Image.open(stream) as original:
                if original.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ImageError("请使用 JPG、PNG 或 WebP 照片。iPhone 可选择“兼容性最佳”拍摄格式。")
                if original.width * original.height > MAX_PIXELS:
                    raise ImageError("照片超过 2400 万像素，请在相机中选择较低分辨率。")
                if getattr(original, "n_frames", 1) != 1:
                    raise ImageError("请上传单张静态照片，不支持动画图片。")
                oriented = ImageOps.exif_transpose(original)
                try:
                    width, height = oriented.size
                    if min(width, height) < 32:
                        raise ImageError("照片尺寸太小，请使用清晰的原始照片。")
                    oriented.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
                    with oriented.convert("RGBA") as rgba:
                        with Image.new("RGBA", rgba.size, "white") as base:
                            base.alpha_composite(rgba)
                            with base.convert("RGB") as working:
                                rgb = np.array(working)
                finally:
                    oriented.close()
    except ImageError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImageError("照片像素过多，请使用不超过 2400 万像素的照片。") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise ImageError("无法读取照片，请重新选择完整的 JPG、PNG 或 WebP 图片。") from exc

    working_height, working_width = rgb.shape[:2]
    offset_x = offset_y = 0
    if options.roi is not None:
        left, top, right, bottom = options.roi
        if not all(np.isfinite(options.roi)) or not (0 <= left < right <= 1 and 0 <= top < bottom <= 1):
            raise ImageError("识别范围无效，请重新选择范围。")
        offset_x, offset_y = int(left * working_width), int(top * working_height)
        end_x, end_y = int(np.ceil(right * working_width)), int(np.ceil(bottom * working_height))
        if end_x - offset_x < 16 or end_y - offset_y < 16:
            raise ImageError("识别范围太小，请包含全部待计数种子。")
        rgb = rgb[offset_y:end_y, offset_x:end_x]
    mask, notes = foreground(rgb, options)
    labels, _ = ndi.label(mask)
    slices = ndi.find_objects(labels)
    min_area = max(8, mask.size * options.min_area_percent / 100)
    # Reject huge regions (usually the background or a tray), rather than
    # returning thousands of fabricated detections within them.
    max_area = mask.size * 0.15
    # A reference requires at least three similarly sized convex components.
    # Do not infer a grain size from one object or from a dense pile alone.
    sizes = []
    for label, bounding in enumerate(slices, 1):
        if bounding is None:
            continue
        region = labels[bounding] == label
        area = int(region.sum())
        if min_area <= area <= max_area and solidity(region) >= 0.94:
            sizes.append(area)
    seed_area = None
    if len(sizes) >= 3:
        median = float(np.median(sizes))
        similar = [area for area in sizes if median * 0.65 <= area <= median * 1.45]
        if len(similar) >= 3 and len(similar) >= len(sizes) * 0.6:
            seed_area = float(np.median(similar))
    points = []
    rejected = 0
    sy, sx = height / working_height, width / working_width
    for label, bounding in enumerate(slices, 1):
        if bounding is None:
            continue
        region = labels[bounding] == label
        area = int(region.sum())
        if area < min_area:
            continue
        if area > max_area:
            rejected += 1
            continue
        # Pad each component so distance_transform sees background on all sides.
        region = np.pad(region, 1)
        parts, uncertain = split_region(region, options.split, seed_area)
        edge = bounding[0].start == 0 or bounding[1].start == 0 or bounding[0].stop == mask.shape[0] or bounding[1].stop == mask.shape[1]
        for part in parts:
            if part.sum() < min_area:
                continue
            cy, cx = ndi.center_of_mass(part)
            # Ensure a dot stays on the object even when the component is concave.
            if not part[int(round(cy)), int(round(cx))]:
                coordinates = np.argwhere(part)
                cy, cx = coordinates[np.argmin(np.sum((coordinates - [cy, cx]) ** 2, axis=1))]
            points.append({
                "id": f"auto-{len(points) + 1}",
                "x": round(float((offset_x + bounding[1].start + cx - 1 + 0.5) * sx), 2),
                "y": round(float((offset_y + bounding[0].start + cy - 1 + 0.5) * sy), 2),
                "source": "auto",
                "review": bool(uncertain or edge),
            })
            if len(points) >= MAX_POINTS:
                raise ImageError("候选种子过多，请分批拍照，或增大“最小种子面积”以排除背景噪点。")
    if rejected:
        notes.append("已排除过大的连通区域，可能有大面积粘连或背景误识别，请人工检查。")
    if options.roi is not None:
        notes.append("本次仅识别选定范围；范围外的种子不计入自动结果，请确认没有漏选。")
    if not points:
        notes.append("没有找到种子。请检查背景模式、照片清晰度，或降低最小种子面积；也可以手动补点。")
    elif any(point["review"] for point in points):
        notes.append("黄色外圈表示疑似粘连或位于边缘的红点，请优先复核；没有外圈也可能存在误差。")
    return {
        "width": width, "height": height, "points": points, "count": len(points),
        "review_count": sum(point["review"] for point in points), "warnings": notes,
        "method": "illumination-segmentation-watershed-v3",
        "roi": list(options.roi) if options.roi is not None else None,
        "working_width": int(mask.shape[1]), "working_height": int(mask.shape[0]),
    }
