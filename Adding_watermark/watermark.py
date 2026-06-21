"""
DADA dual watermark engine.

Two layers on every image:
  1. a subtle VISIBLE mark (logo text, bottom-right) — deters casual theft.
  2. an INVISIBLE forensic watermark (frequency-domain DWT-DCT via
     `blind-watermark`) — survives recompression / resize / screenshots well
     enough to PROVE ownership later.

The invisible payload is a short fixed-length code (e.g. DADA20260619a1b2c3d4)
that maps to a registry row (shoot / date / note). Because the code length is
fixed, the verifier needs no per-image metadata to decode it.
"""
from __future__ import annotations

import os
import secrets
import datetime
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont, ImageOps
from blind_watermark import WaterMark

# iPhones save photos as HEIC by default; without this, Image.open() raises and
# the whole request 500s (the "Internal Server Error" when adding a phone photo).
try:
    import pillow_heif  # type: ignore
    pillow_heif.register_heif_opener()
except Exception:
    pass

# Cap the working resolution. Phone/camera photos are often 12MP+, and the
# DWT-DCT embed allocates several float64 copies of the whole image — enough to
# blow past a 512MB host AND make each embed slow. 1280px on the long side is
# plenty for web/social use and keeps each image well under ~5s even on a small
# shared host. Override with WM_MAX_SIDE (e.g. 1600/2000 for higher fidelity).
MAX_SIDE = int(os.environ.get("WM_MAX_SIDE", "1280"))

# Secret seeds for the invisible watermark. The SAME values are needed to
# extract, so keep them private and stable. In production they're set via env
# (WM_PASSWORD_IMG / WM_PASSWORD_WM) so the real keys never live in git; the
# defaults below are only for local dev.
PASSWORD_IMG = int(os.environ.get("WM_PASSWORD_IMG", "20260619"))
PASSWORD_WM = int(os.environ.get("WM_PASSWORD_WM", "731"))

CODE_LEN = 20  # exact number of ASCII characters embedded

_DIR = os.path.dirname(os.path.abspath(__file__))
LOGO_WHITE = os.path.join(_DIR, "logo-white.png")
LOGO_BLACK = os.path.join(_DIR, "logo-black.png")

# Quiet blind-watermark's progress chatter.
try:
    from blind_watermark import bw_notes  # type: ignore
    bw_notes.close()
except Exception:
    pass


def make_code() -> str:
    """A 20-char ASCII code: DADA + YYYYMMDD + 8 hex random."""
    d = datetime.datetime.now().strftime("%Y%m%d")
    code = f"DADA{d}{secrets.token_hex(4)}"
    return code[:CODE_LEN].ljust(CODE_LEN, "0")


@lru_cache(maxsize=1)
def wm_bit_len() -> int:
    """Bit length of a CODE_LEN ASCII string in blind-watermark 'str' mode."""
    bwm = WaterMark(password_img=PASSWORD_IMG, password_wm=PASSWORD_WM)
    bwm.read_wm("A" * CODE_LEN, mode="str")
    return len(bwm.wm_bit)


def _load_font(size: int):
    for name in ("arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _add_text(img: "Image.Image", text: str) -> "Image.Image":
    w, h = img.size
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = _load_font(max(16, w // 28))
    box = draw.textbbox((0, 0), text, font=font)
    tw, th = box[2] - box[0], box[3] - box[1]
    x, y = w - tw - w // 40, h - th - h // 25
    draw.text((x + 2, y + 2), text, font=font, fill=(0, 0, 0, 90))
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 150))
    return Image.alpha_composite(img, overlay)


def _xy(w: int, h: int, lw: int, lh: int, position: str):
    mx, my = w // 28, h // 28
    pos = {
        "br": (w - lw - mx, h - lh - my),
        "bl": (mx, h - lh - my),
        "tr": (w - lw - mx, my),
        "tl": (mx, my),
        "center": ((w - lw) // 2, (h - lh) // 2),
    }
    return pos.get(position, pos["br"])


def add_visible(
    in_path: str,
    out_path: str,
    opacity: float = 0.55,
    scale: float = 0.20,
    position: str = "br",
    text: str = "DĀDA ISLAND",
) -> None:
    """Overlay the white DADA logo (position / opacity / scale configurable)."""
    img = Image.open(in_path).convert("RGBA")
    w, h = img.size
    if os.path.exists(LOGO_WHITE):
        logo = Image.open(LOGO_WHITE).convert("RGBA")
        lw = max(80, int(w * scale))
        lh = max(1, int(logo.height * lw / logo.width))
        logo = logo.resize((lw, lh), Image.LANCZOS)
        alpha = logo.split()[3].point(lambda a: int(a * opacity))
        logo.putalpha(alpha)
        img.alpha_composite(logo, _xy(w, h, lw, lh, position))
        out = img
    else:
        out = _add_text(img, text)
    out.convert("RGB").save(out_path, quality=95)


def embed_invisible(in_path: str, out_path: str, code: str) -> None:
    bwm = WaterMark(password_img=PASSWORD_IMG, password_wm=PASSWORD_WM)
    bwm.read_img(in_path)
    bwm.read_wm(code, mode="str")
    bwm.embed(out_path)


def extract_invisible(path: str) -> str:
    bwm = WaterMark(password_img=PASSWORD_IMG, password_wm=PASSWORD_WM)
    return bwm.extract(path, wm_shape=wm_bit_len(), mode="str")


def _downscaled(in_path: str, work_path: str) -> str:
    """If the image's long side exceeds MAX_SIDE, write a downscaled, EXIF-rotated
    copy to work_path and return it; otherwise return in_path unchanged. Keeps the
    DWT-DCT embed within a small host's memory."""
    try:
        with Image.open(in_path) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")  # bake orientation
            w, h = im.size
            if max(w, h) <= MAX_SIDE:
                return in_path
            r = MAX_SIDE / max(w, h)
            im = im.resize((max(1, round(w * r)), max(1, round(h * r))), Image.LANCZOS)
            im.save(work_path, "JPEG", quality=95)
            return work_path
    except Exception:
        return in_path  # never block watermarking just because resize failed


def watermark_image(
    in_path: str,
    out_path: str,
    code: str,
    visible: bool = True,
    opacity: float = 0.55,
    scale: float = 0.20,
    position: str = "br",
    visible_text: str = "DĀDA ISLAND",
) -> None:
    """Apply visible mark (optional) then embed the invisible code into the result."""
    work = out_path + ".src.jpg"
    src = _downscaled(in_path, work)  # cap resolution first (memory/time)
    tmp = out_path + ".tmp.png"
    if visible:
        add_visible(src, tmp, opacity=opacity, scale=scale, position=position, text=visible_text)
        src = tmp
    try:
        embed_invisible(src, out_path, code)
    finally:
        for p in (tmp, work):
            if p != in_path and os.path.exists(p):
                os.remove(p)
