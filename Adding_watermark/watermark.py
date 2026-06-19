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

from PIL import Image, ImageDraw, ImageFont
from blind_watermark import WaterMark

# Secret seeds — change these once for production and keep them private; the
# same values are needed to extract. (Anyone with these can read/forge marks.)
PASSWORD_IMG = 20260619
PASSWORD_WM = 731

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


def add_visible(
    in_path: str,
    out_path: str,
    opacity: float = 0.55,
    scale: float = 0.20,
    text: str = "DĀDA ISLAND",
) -> None:
    """Overlay the white DADA logo in the bottom-right corner (text fallback)."""
    img = Image.open(in_path).convert("RGBA")
    w, h = img.size
    if os.path.exists(LOGO_WHITE):
        logo = Image.open(LOGO_WHITE).convert("RGBA")
        lw = max(80, int(w * scale))
        lh = max(1, int(logo.height * lw / logo.width))
        logo = logo.resize((lw, lh), Image.LANCZOS)
        alpha = logo.split()[3].point(lambda a: int(a * opacity))
        logo.putalpha(alpha)
        x, y = w - lw - w // 28, h - lh - h // 28
        img.alpha_composite(logo, (x, y))
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


def watermark_image(
    in_path: str,
    out_path: str,
    code: str,
    visible: bool = True,
    visible_text: str = "DĀDA ISLAND",
) -> None:
    """Apply visible mark (optional) then embed the invisible code into the result."""
    tmp = out_path + ".tmp.png"
    src = in_path
    if visible:
        add_visible(in_path, tmp, text=visible_text)
        src = tmp
    try:
        embed_invisible(src, out_path, code)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
