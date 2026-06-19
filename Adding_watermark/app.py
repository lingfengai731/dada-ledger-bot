"""
DADA Watermark — web app.

  /        upload one or many images -> visible logo + invisible watermark, logged.
  /verify  upload a suspected-stolen image -> read the invisible code -> show the match.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
Styled to match dada-island.com (dark, minimal). Login gated by WATERMARK_PASSWORD.
"""
from __future__ import annotations

import os
import io
import time
import zipfile
import sqlite3
import secrets
import datetime
import hashlib

from fastapi import FastAPI, UploadFile, File, Form, Request
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse, StreamingResponse

import watermark as wm

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("DATA_DIR", BASE)  # set to a mounted disk in prod for persistence
UP = os.path.join(DATA, "uploads")
OUT = os.path.join(DATA, "outputs")
DB = os.path.join(DATA, "registry.db")
os.makedirs(UP, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

db = sqlite3.connect(DB, check_same_thread=False)
db.execute(
    """CREATE TABLE IF NOT EXISTS images (
        code TEXT PRIMARY KEY, shoot TEXT, note TEXT,
        orig_name TEXT, created_at TEXT, batch TEXT)"""
)
try:
    db.execute("ALTER TABLE images ADD COLUMN batch TEXT")  # migrate older DBs
except sqlite3.OperationalError:
    pass
db.commit()

PASSWORD = os.environ.get("WATERMARK_PASSWORD", "")


def _auth_token() -> str:
    return hashlib.sha256(f"dada-wm::{PASSWORD}".encode()).hexdigest()[:32]


app = FastAPI(title="DADA Watermark")


@app.middleware("http")
async def require_login(request: Request, call_next):
    if PASSWORD and request.url.path not in ("/login", "/logo"):
        if request.cookies.get("wm_auth") != _auth_token():
            return RedirectResponse("/login", status_code=302)
    return await call_next(request)


STYLE = """
*{box-sizing:border-box}
body{background:#0b0b0b;color:#f2f2f0;margin:0;
 font-family:'Helvetica Neue',Helvetica,Arial,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:640px;margin:0 auto;padding:3rem 1.25rem 4rem}
.logo{display:block;margin:0 auto 1.7rem;width:168px;opacity:.95}
.nav{text-align:center;letter-spacing:.2em;font-size:11px;text-transform:uppercase;margin-bottom:2.6rem}
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
select{background:#0b0b0b;color:#fff;border:1px solid rgba(255,255,255,.25);padding:.45rem;font-family:inherit}
input[type=range]{width:100%;accent-color:#fff}
.row{display:flex;gap:1.2rem;flex-wrap:wrap}.row>div{flex:1;min-width:160px}
.drop{border:1px dashed rgba(255,255,255,.3);padding:1.6rem;text-align:center;color:#9a9a98;
 font-size:13px;cursor:pointer;margin-top:.3rem}
.drop.over{border-color:#fff;color:#fff}
.check{display:flex;align-items:center;gap:.55rem;font-size:13px;color:#cfcfcd;margin-top:1.1rem}
button,.btn{display:inline-block;margin-top:1.7rem;background:#fff;color:#0b0b0b;border:0;
 padding:.85rem 1.9rem;font-size:11px;letter-spacing:.2em;text-transform:uppercase;cursor:pointer;
 font-family:inherit;text-decoration:none}
.code{font-family:ui-monospace,'SF Mono',Menlo,monospace;letter-spacing:.05em;
 background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);padding:.2rem .45rem}
.ok{color:#cfe8d4}.bad{color:#e8b6ad}
img.prev{max-width:100%;margin-top:1.5rem;border:1px solid rgba(255,255,255,.12)}
.item{display:flex;justify-content:space-between;align-items:center;gap:1rem;
 border-bottom:1px solid rgba(255,255,255,.1);padding:.6rem 0;font-size:13px;color:#cfcfcd}
.item a{color:#fff;text-decoration:none;border-bottom:1px solid #fff;font-size:11px;letter-spacing:.12em;text-transform:uppercase}
a.back{display:inline-block;margin-top:1.5rem;color:#8f8f8d;text-decoration:none;letter-spacing:.04em;font-size:13px}
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


@app.get("/login", response_class=HTMLResponse)
def login_page(bad: int = 0) -> str:
    err = '<p class="bad">Wrong password.</p>' if bad else ""
    return page(
        f"""<h1>Enter password</h1>{err}
        <div class="card"><form action="/login" method="post">
          <label>Password</label><input type="text" name="password" autofocus>
          <button type="submit">Enter</button>
        </form></div>"""
    )


@app.post("/login")
def login(password: str = Form("")):
    if PASSWORD and password == PASSWORD:
        resp = RedirectResponse("/", status_code=302)
        resp.set_cookie("wm_auth", _auth_token(), max_age=60 * 60 * 24 * 30, httponly=True, samesite="none", secure=True)
        return resp
    return RedirectResponse("/login?bad=1", status_code=302)


DROP_JS = """<script>
(function(){var d=document.getElementById('drop'),f=document.getElementById('file'),n=document.getElementById('cnt');
function upd(){n.textContent=f.files.length?f.files.length+' image(s) selected':'Drag images here, or click to choose';}
d.onclick=function(){f.click()};f.onchange=upd;
['dragover','dragenter'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.add('over')})});
['dragleave','drop'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.remove('over')})});
d.addEventListener('drop',function(ev){f.files=ev.dataTransfer.files;upd()});upd();})();
</script>"""


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return page(
        """<h1>Protect your photos</h1>
        <p>Add one or many images. Each gets a faint DADA logo <i>and</i> a hidden forensic
        watermark, then it's logged so we can prove it's ours if it's ever stolen.</p>
        <div class="card"><form action="/embed" method="post" enctype="multipart/form-data">
          <input id="file" type="file" name="files" accept="image/*" multiple required style="display:none">
          <div id="drop" class="drop">Drag images here, or click to choose</div>
          <div id="cnt" style="font-size:12px;color:#8f8f8d;margin-top:.5rem"></div>
          <label>Shoot / client</label><input type="text" name="shoot" placeholder="e.g. Coco — Komaneka 16 Jun">
          <label>Note</label><input type="text" name="note" placeholder="optional">
          <div class="row">
            <div><label>Logo position</label>
              <select name="position">
                <option value="br">Bottom-right</option><option value="bl">Bottom-left</option>
                <option value="tr">Top-right</option><option value="tl">Top-left</option>
                <option value="center">Center</option>
              </select></div>
            <div><label>Logo opacity</label><input type="range" name="opacity" min="0.2" max="0.9" step="0.05" value="0.55"></div>
            <div><label>Logo size</label><input type="range" name="scale" min="0.1" max="0.4" step="0.02" value="0.2"></div>
          </div>
          <div class="check"><input type="checkbox" name="visible" checked id="v"><label for="v" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:#cfcfcd">add the visible logo (uncheck for invisible-only)</label></div>
          <button type="submit">Watermark</button>
        </form></div>""" + DROP_JS,
        "add",
    )


def _f(v, lo, hi, default):
    try:
        return min(hi, max(lo, float(v)))
    except (TypeError, ValueError):
        return default


@app.post("/embed")
async def embed(
    files: list[UploadFile] = File(...),
    shoot: str = Form(""),
    note: str = Form(""),
    visible: str = Form(None),
    position: str = Form("br"),
    opacity: str = Form("0.55"),
    scale: str = Form("0.2"),
):
    op, sc = _f(opacity, 0.2, 0.9, 0.55), _f(scale, 0.1, 0.4, 0.2)
    batch = f"B{int(time.time())}{secrets.token_hex(2)}"
    now = datetime.datetime.now().isoformat(timespec="seconds")
    for f in files:
        code = wm.make_code()
        in_path = os.path.join(UP, f"{code}_{f.filename}")
        out_path = os.path.join(OUT, f"{code}.jpg")
        with open(in_path, "wb") as fh:
            fh.write(await f.read())
        wm.watermark_image(in_path, out_path, code, visible=bool(visible), opacity=op, scale=sc, position=position)
        db.execute("INSERT OR REPLACE INTO images VALUES (?,?,?,?,?,?)", (code, shoot, note, f.filename, now, batch))
    db.commit()
    return RedirectResponse(f"/result/{batch}", status_code=303)


@app.get("/result/{batch}", response_class=HTMLResponse)
def result(batch: str) -> str:
    rows = db.execute("SELECT code, orig_name FROM images WHERE batch=? ORDER BY rowid", (batch,)).fetchall()
    if not rows:
        return page('<h1>Not found</h1><a class="back" href="/">← back</a>', "add")
    if len(rows) == 1:
        code = rows[0][0]
        body = f"""<h1>Done</h1>
        <p>Hidden code: <span class="code">{code}</span></p>
        <p><a class="btn" href="/download/{code}">Download</a></p>
        <img class="prev" src="/download/{code}">
        <a class="back" href="/">← watermark more</a>"""
    else:
        items = "".join(
            f'<div class="item"><span>{(r[1] or r[0])}</span><a href="/download/{r[0]}">Download</a></div>'
            for r in rows
        )
        body = f"""<h1>Done — {len(rows)} images</h1>
        <p><a class="btn" href="/zip/{batch}">Download all (zip)</a></p>
        <div class="card">{items}</div>
        <a class="back" href="/">← watermark more</a>"""
    return page(body, "add")


@app.get("/download/{code}")
def download(code: str):
    path = os.path.join(OUT, f"{code}.jpg")
    if not os.path.exists(path):
        return HTMLResponse("not found", status_code=404)
    return FileResponse(path, media_type="image/jpeg", filename=f"{code}.jpg")


@app.get("/zip/{batch}")
def zip_batch(batch: str):
    rows = db.execute("SELECT code, orig_name FROM images WHERE batch=? ORDER BY rowid", (batch,)).fetchall()
    if not rows:
        return HTMLResponse("not found", status_code=404)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for code, orig in rows:
            p = os.path.join(OUT, f"{code}.jpg")
            if os.path.exists(p):
                base = os.path.splitext(orig or code)[0]
                z.write(p, f"{base}_dada.jpg")
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="dada-watermarked-{batch}.zip"'},
    )


@app.get("/verify", response_class=HTMLResponse)
def verify_page() -> str:
    return page(
        """<h1>Verify a stolen image</h1>
        <p>Drop in a photo you think was taken from us. We'll read the hidden watermark
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
    tmp = os.path.join(UP, f"_verify_{secrets.token_hex(4)}")
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
