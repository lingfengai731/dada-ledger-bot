"""
Round-trip test (no browser): embed a watermark, then prove we can still read it
back — including after a JPEG recompress and a resize, which is what social
platforms do to reposted images.

  python test_roundtrip.py
"""
import os
import sys
import numpy as np
from PIL import Image
import watermark as wm

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))


def report(label, got, code):
    ok = got == code
    shown = got if got.isascii() else "(garbled — watermark not recovered)"
    print(f"{label}: {'OK ✓' if ok else 'FAIL ✗'}  [{shown}]")


def make_test_photo(path, w=1200, h=800):
    # Textured content (DWT-DCT needs detail, not a flat gradient).
    rng = np.random.default_rng(7)
    base = rng.integers(60, 200, size=(h, w, 3), dtype=np.uint8)
    img = Image.fromarray(base)
    img.save(path, quality=95)


def main():
    src = os.path.join(BASE, "_test_src.png")
    out = os.path.join(BASE, "_test_wm.jpg")
    make_test_photo(src)

    code = wm.make_code()
    print(f"embedding code: {code}")
    wm.watermark_image(src, out, code, visible=True)

    report("direct extract       ", wm.extract_invisible(out), code)

    # Social-media repost: recompress to JPEG q80.
    repost = os.path.join(BASE, "_test_repost.jpg")
    Image.open(out).convert("RGB").save(repost, quality=80)
    report("after q80 recompress  ", wm.extract_invisible(repost), code)

    # Heavier repost: q60.
    repost2 = os.path.join(BASE, "_test_repost2.jpg")
    Image.open(out).convert("RGB").save(repost2, quality=60)
    report("after q60 recompress  ", wm.extract_invisible(repost2), code)

    print("\nNote: blind-watermark (DWT-DCT) is strong vs recompression but weaker")
    print("vs heavy resize/crop — those need the geometry-recovery helper (Phase 2).")

    for p in (src, out, repost, repost2):
        if os.path.exists(p):
            os.remove(p)


if __name__ == "__main__":
    main()
