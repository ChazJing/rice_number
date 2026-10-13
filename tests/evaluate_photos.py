"""Evaluate private photos locally without committing them or creating images.

python tests/evaluate_photos.py work/private-photos/example.jpg --roi 0 0 1 .85
Use --reference-count only for an independently checked visible grain count.
"""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.detection import Options, detect_image


def main():
    parser = argparse.ArgumentParser(description="Private rice-photo counting evaluation")
    parser.add_argument("photos", nargs="+", type=Path)
    parser.add_argument("--roi", nargs=4, type=float, metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"))
    parser.add_argument("--sensitivity", type=float, default=0)
    parser.add_argument("--reference-count", type=int)
    args = parser.parse_args()
    if args.reference_count is not None and (args.reference_count <= 0 or len(args.photos) != 1):
        parser.error("--reference-count requires one photo and a positive count")
    for photo in args.photos:
        start = time.perf_counter()
        result = detect_image(photo.read_bytes(), Options(sensitivity=args.sensitivity,
                             roi=tuple(args.roi) if args.roi else None))
        report = {"photo": photo.name, "count": result["count"], "review_count": result["review_count"],
                  "method": result["method"], "roi": result["roi"],
                  "seconds": round(time.perf_counter() - start, 3), "warnings": result["warnings"]}
        if args.reference_count is not None:
            report["reference_count"] = args.reference_count
            report["total_count_error_percent"] = round(abs(result["count"] - args.reference_count) / args.reference_count * 100, 2)
            report["evaluation_note"] = "Total-count error does not measure per-grain misses or duplicates."
        print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
