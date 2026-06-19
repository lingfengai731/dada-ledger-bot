"""
DADA Watermark — Phase 1 web app.

  /        upload an image -> visible logo + invisible watermark, logged, returned.
  /verify  upload a suspected-stolen image -> read the invisible code -> show the match.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
Styled to match dada-island.com (dark, minimal, wide letter-spacing).
"""
from __future__ import annotations

import os
import sqlite3
import datetime

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import HTMLResponse, FileResponse

import watermark as wm

BASE = os.path.dirname(os.path.abspath(__file__))
UP = os.path.join(BASE, "uploads")
OUT = os.path.join(BASE, "outputs")
DB = os.path.join(BASE, "registry.db")
os.makedirs(UP, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

db = sqlite3.connect(DB, check_same_thread=False)
db.execute(
    """CREATE TABLE IF NOT EXISTS images (
        code TEXT PRIMARY KEY, shoot TEXT, note TEXT,
        orig_name TEXT, created_at TEXT)"""
)
db.commit()

app = FastAPI(title="DADA Watermark")

STYLE = """
*{box-sizing:border-box}
body{background:#0b0b0b;color:#f2f2f0;margin:0;
 font-family:'Helvetica Neue',Helvetica,Arial,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:640px;margin:0 auto;padding:3rem 1.25rem 4rem}
.logo{display:block;margin:0 auto 1.7rem;width:168px;opacity:.95}
.nav{text-align:center;letter-spacing:.2em;font-size:11px;text-transform:uppercase;margin-bottom:2.8rem}
.nav a{color:#9a9a98;text-decoration:none;margin:0 .9rem;padding-bottom:.35rem;border-bottom:1px solid transparent}
.nav a.on{color:#fff;border-bottom-color:#fff}
h1{font-weight:300;font-size:23px;letter-spacing:.05em;margin:.2rem 0 1rem}
p{color:#cfcfcd;line-height:1.75;font-weight:300}
.card{border:1px solid rgba(255,255,255,.14);padding:1.7rem;margin:1.5rem 0}
label{display:block;margin:1.1rem 0 .35rem;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8f8f8d}
input[type=text]{width:100%;background:transparent;border:0;border-bottom:1px solid rgba(255,255,255,.25);
 color:#fff;padding:.5rem 0;font-size:15px;font-family:inherit}
input[type=text]:focus{outline:none;border-bottom-color:#fff}
input[type=file]{color:#cfcfcd;font-size:14px;width:100%}
.check{display:flex;align-items:center;gap:.55rem;font-size:13px;color:#cfcfcd;margin-top:1.1rem}
button,.btn{display:inline-block;margin-top:1.7rem;background:#fff;color:#0b0b0b;border:0;
 padding:.85rem 1.9rem;font-size:11px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;
 font-family:inherit;text-decoration:none}
.code{font-family:ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:.05em;
 background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);padding:.25rem .5rem}
.ok{color:#cfe8d4}.bad{color:#e8b6ad}
img.prev{max-width:100%;margin-top:1.5rem;border:1px solid rgba(255,255,255,.12)}
a.back{display:inline-block;margin-top:1.5rem;color:#8f8f8d;text-decoration:none;
 letter-spacing:.04em;font-size:13px}
"""


def page(body: str, active: str = "") -> str:
    def on(n: str) -> str:
        return "on" if active == n else ""
    return f"""<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DADA Watermark</title><style>{STYLE}</style>
<div class="wrap">
  <img class="logo" src="/logo" alt="DADA ISLAND">
  <div class="nav"><a class="{on('add')}" href="/">Add watermark</a><a class="{on('verify')}" href="/verify">Verify</a></div>
  {body}
</div>"""


@app.get("/logo")
def logo():
    return FileResponse(os.path.join(BASE, "logo-white.png"), media_type="image/png")


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return page(
        """<h1>Protect a photo</h1>
        <p>Upload an image. It gets a faint visible logo <i>and</i> a hidden forensic watermark,
        then it's logged so we can prove it's ours if it's ever stolen.</p>
        <div class="card"><form action="/embed" method="post" enctype="multipart/form-data">
          <label>Image</label><input type="file" name="file" accept="image/*" required>
          <label>Shoot / client</label><input type="text" name="shoot" placeholder="e.g. Coco — Komaneka 16 Jun">
          <label>Note</label><input type="text" name="note" placeholder="optional">
          <div class="check"><input type="checkbox" name="visible" checked id="v"><label for="v" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:#cfcfcd">also add the visible logo</label></div>
          <button type="submit">Watermark it</button>
        </form></div>""",
        "add",
    )


@app.post("/embed", response_class=HTMLResponse)
async def embed(
    file: UploadFile = File(...),
    shoot: str = Form(""),
    note: str = Form(""),
    visible: str = Form(None),
):
    code = wm.make_code()
    in_path = os.path.join(UP, f"{code}_{file.filename}")
    out_path = os.path.join(OUT, f"{code}.jpg")
    with open(in_path, "wb") as f:
        f.write(await file.read())
    wm.watermark_image(in_path, out_path, code, visible=bool(visible))
    db.execute(
        "INSERT OR REPLACE INTO images VALUES (?,?,?,?,?)",
        (code, shoot, note, file.filename, datetime.datetime.now().isoformat(timespec="seconds")),
    )
    db.commit()
    return page(
        f"""<h1>Done</h1>
        <p>Hidden code embedded: <span class="code">{code}</span></p>
        <p><a class="btn" href="/download/{code}">Download</a></p>
        <img class="prev" src="/download/{code}">
        <a class="back" href="/">← watermark another</a>""",
        "add",
    )


@app.get("/download/{code}")
def download(code: str):
    path = os.path.join(OUT, f"{code}.jpg")
    if not os.path.exists(path):
        return HTMLResponse("not found", status_code=404)
    return FileResponse(path, media_type="image/jpeg", filename=f"{code}.jpg")


@app.get("/verify", response_class=HTMLResponse)
def verify_page() -> str:
    return page(
        """<h1>Verify a stolen image</h1>
        <p>Drop in a photo you think was taken from us. We'll try to read the hidden watermark
        and tell you which shoot it's from.</p>
        <div class="card"><form action="/verify" method="post" enctype="multipart/form-data">
          <label>Suspected image</label><input type="file" name="file" accept="image/*" required>
          <button type="submit">Check it</button>
        </form></div>""",
        "verify",
    )


def _hamming(a: str, b: str) -> int:
    n = min(len(a), len(b))
    return sum(1 for i in range(n) if a[i] != b[i]) + abs(len(a) - len(b))


def _best_match(code: str):
    best, best_d = None, 999
    for row in db.execute("SELECT code, shoot, note, created_at FROM images").fetchall():
        d = _hamming(code, row[0])
        if d < best_d:
            best_d, best = d, row
    return best, best_d


@app.post("/verify", response_class=HTMLResponse)
async def verify(file: UploadFile = File(...)):
    tmp = os.path.join(UP, f"_verify_{file.filename}")
    with open(tmp, "wb") as f:
        f.write(await file.read())
    try:
        code = wm.extract_invisible(tmp)
    except Exception:
        code = ""
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    best, dist = _best_match(code) if code else (None, 999)
    if best and dist <= 4:
        approx = "" if dist == 0 else f' <i>(approximate match, {dist} char(s) off — still ours)</i>'
        body = f"""<h1 class="ok">✓ This is DADA's image</h1><p>{approx}</p>
        <p>Matched code: <span class="code">{best[0]}</span></p>
        <p>Shoot: <b>{best[1] or '—'}</b><br>Note: {best[2] or '—'}<br>Watermarked on: {best[3]}</p>
        <a class="back" href="/verify">← check another</a>"""
    elif code.startswith("DADA"):
        body = f"""<h1 class="ok">✓ DADA watermark found</h1>
        <p>Code <span class="code">{code}</span> isn't in this registry (watermarked elsewhere?), but the mark looks like ours.</p>
        <a class="back" href="/verify">← check another</a>"""
    else:
        body = """<h1 class="bad">✗ No DADA watermark detected</h1>
        <p>Either it isn't ours, or the watermark was destroyed by heavy editing / cropping.</p>
        <a class="back" href="/verify">← try another</a>"""
    return page(body, "verify")
