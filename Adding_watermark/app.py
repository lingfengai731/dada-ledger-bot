"""
DADA Watermark — web app.

  /        upload one or many images -> visible logo + invisible watermark, logged.
  /verify  upload a suspected-stolen image -> read the invisible code -> show the match.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
Styled to match dada-island.com (dark, minimal). Login gated by WATERMARK_PASSWORD.
UI is trilingual (EN / 中文 / Bahasa) via a top-right switcher; see LANG_SCRIPT.
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
.lang{position:fixed;top:1.1rem;right:1.2rem;z-index:20;font-size:11px;letter-spacing:.16em;text-transform:uppercase}
.lang a{color:#9a9a98;text-decoration:none;margin-left:.75rem;padding-bottom:.2rem;border-bottom:1px solid transparent;cursor:pointer}
.lang a.on{color:#fff;border-bottom-color:#fff}
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


# Top-right language switcher + client-side i18n. Every translatable element
# carries data-t (textContent) or data-tp (placeholder); data-n fills "{n}".
# NOTE: this is a plain string (NOT an f-string) so the JS "{}" stay literal.
LANG_SCRIPT = """
<div class="lang">
  <a data-lang="en" onclick="setLang('en')">EN</a>
  <a data-lang="zh" onclick="setLang('zh')">中</a>
  <a data-lang="id" onclick="setLang('id')">ID</a>
</div>
<script>
var I18N={
 en:{nav_add:"Add watermark",nav_verify:"Verify",
  home_h1:"Protect your photos",
  home_p:"Add one or many images. Each gets a faint DADA logo and a hidden forensic watermark, then it's logged so we can prove it's ours if it's ever stolen.",
  drag:"Drag images here, or click to choose",sel:"{n} image(s) selected",
  lbl_shoot:"Shoot / client",ph_shoot:"e.g. Coco — Komaneka 16 Jun",
  lbl_note:"Note",ph_optional:"optional",
  lbl_pos:"Logo position",pos_br:"Bottom-right",pos_bl:"Bottom-left",pos_tr:"Top-right",pos_tl:"Top-left",pos_center:"Center",
  lbl_opacity:"Logo opacity",lbl_size:"Logo size",
  chk_visible:"add the visible logo (uncheck for invisible-only)",btn_watermark:"Watermark",
  res_done:"Done",res_code:"Hidden code:",btn_download:"Download",back_more:"\\u2190 watermark more",
  res_done_n:"Done \\u2014 {n} images",btn_zip:"Download all (zip)",not_found:"Not found",back:"\\u2190 back",
  ver_h1:"Verify a stolen image",
  ver_p:"Drop in a photo you think was taken from us. We'll read the hidden watermark and tell you which shoot it's from.",
  lbl_suspect:"Suspected image",btn_check:"Check it",
  ver_ok_h1:"\\u2713 This is DADA's image",ver_approx:"approximate match, {n} char(s) off \\u2014 still ours",
  ver_matched:"Matched code:",ver_shoot:"Shoot:",ver_note:"Note:",ver_on:"Watermarked on:",
  ver_found_h1:"\\u2713 DADA watermark found",ver_found_code:"Code",
  ver_found_p:"isn't in this registry (watermarked elsewhere?), but the mark looks like ours.",
  ver_none_h1:"\\u2717 No DADA watermark detected",
  ver_none_p:"Either it isn't ours, or the watermark was destroyed by heavy editing / cropping.",
  back_check:"\\u2190 check another",back_try:"\\u2190 try another",
  login_h1:"Enter password",login_wrong:"Wrong password.",lbl_password:"Password",btn_enter:"Enter"},
 zh:{nav_add:"\\u6dfb\\u52a0\\u6c34\\u5370",nav_verify:"\\u9a8c\\u8bc1",
  home_h1:"\\u4fdd\\u62a4\\u4f60\\u7684\\u7167\\u7247",
  home_p:"\\u4e0a\\u4f20\\u4e00\\u5f20\\u6216\\u591a\\u5f20\\u56fe\\u7247\\u3002\\u6bcf\\u5f20\\u90fd\\u4f1a\\u52a0\\u4e0a\\u6de1\\u6de1\\u7684 DADA \\u6807\\u5fd7\\u548c\\u4e00\\u6bb5\\u9690\\u5f62\\u53d6\\u8bc1\\u6c34\\u5370\\uff0c\\u5e76\\u81ea\\u52a8\\u767b\\u8bb0\\u2014\\u2014\\u4e00\\u65e6\\u88ab\\u76d7\\uff0c\\u6211\\u4eec\\u80fd\\u8bc1\\u660e\\u5b83\\u5c5e\\u4e8e DADA\\u3002",
  drag:"\\u628a\\u56fe\\u7247\\u62d6\\u5230\\u8fd9\\u91cc\\uff0c\\u6216\\u70b9\\u51fb\\u9009\\u62e9",sel:"\\u5df2\\u9009\\u62e9 {n} \\u5f20\\u56fe\\u7247",
  lbl_shoot:"\\u62cd\\u6444 / \\u5ba2\\u6237",ph_shoot:"\\u4f8b\\uff1aCoco \\u2014 Komaneka 6\\u670816\\u65e5",
  lbl_note:"\\u5907\\u6ce8",ph_optional:"\\u53ef\\u9009",
  lbl_pos:"\\u6807\\u5fd7\\u4f4d\\u7f6e",pos_br:"\\u53f3\\u4e0b",pos_bl:"\\u5de6\\u4e0b",pos_tr:"\\u53f3\\u4e0a",pos_tl:"\\u5de6\\u4e0a",pos_center:"\\u5c45\\u4e2d",
  lbl_opacity:"\\u6807\\u5fd7\\u900f\\u660e\\u5ea6",lbl_size:"\\u6807\\u5fd7\\u5927\\u5c0f",
  chk_visible:"\\u6dfb\\u52a0\\u53ef\\u89c1\\u6807\\u5fd7\\uff08\\u53d6\\u6d88\\u52fe\\u9009\\u5219\\u53ea\\u52a0\\u9690\\u5f62\\u6c34\\u5370\\uff09",btn_watermark:"\\u52a0\\u6c34\\u5370",
  res_done:"\\u5b8c\\u6210",res_code:"\\u9690\\u85cf\\u7f16\\u7801\\uff1a",btn_download:"\\u4e0b\\u8f7d",back_more:"\\u2190 \\u7ee7\\u7eed\\u52a0\\u6c34\\u5370",
  res_done_n:"\\u5b8c\\u6210 \\u2014 {n} \\u5f20\\u56fe\\u7247",btn_zip:"\\u6253\\u5305\\u4e0b\\u8f7d\\u5168\\u90e8\\uff08zip\\uff09",not_found:"\\u672a\\u627e\\u5230",back:"\\u2190 \\u8fd4\\u56de",
  ver_h1:"\\u9a8c\\u8bc1\\u88ab\\u76d7\\u56fe\\u7247",
  ver_p:"\\u628a\\u4f60\\u6000\\u7591\\u88ab\\u76d7\\u7528\\u7684\\u56fe\\u7247\\u62d6\\u8fdb\\u6765\\uff0c\\u6211\\u4eec\\u4f1a\\u8bfb\\u53d6\\u9690\\u5f62\\u6c34\\u5370\\uff0c\\u544a\\u8bc9\\u4f60\\u5b83\\u6765\\u81ea\\u54ea\\u4e00\\u573a\\u62cd\\u6444\\u3002",
  lbl_suspect:"\\u53ef\\u7591\\u56fe\\u7247",btn_check:"\\u68c0\\u67e5",
  ver_ok_h1:"\\u2713 \\u8fd9\\u662f DADA \\u7684\\u56fe\\u7247",ver_approx:"\\u8fd1\\u4f3c\\u5339\\u914d\\uff0c\\u5dee {n} \\u4e2a\\u5b57\\u7b26 \\u2014 \\u4ecd\\u662f\\u6211\\u4eec\\u7684",
  ver_matched:"\\u5339\\u914d\\u7f16\\u7801\\uff1a",ver_shoot:"\\u62cd\\u6444\\uff1a",ver_note:"\\u5907\\u6ce8\\uff1a",ver_on:"\\u52a0\\u6c34\\u5370\\u65f6\\u95f4\\uff1a",
  ver_found_h1:"\\u2713 \\u68c0\\u6d4b\\u5230 DADA \\u6c34\\u5370",ver_found_code:"\\u7f16\\u7801",
  ver_found_p:"\\u4e0d\\u5728\\u672c\\u767b\\u8bb0\\u5e93\\u4e2d\\uff08\\u53ef\\u80fd\\u5728\\u522b\\u5904\\u52a0\\u7684\\u6c34\\u5370\\uff09\\uff0c\\u4f46\\u8fd9\\u4e2a\\u6807\\u8bb0\\u770b\\u8d77\\u6765\\u662f\\u6211\\u4eec\\u7684\\u3002",
  ver_none_h1:"\\u2717 \\u672a\\u68c0\\u6d4b\\u5230 DADA \\u6c34\\u5370",
  ver_none_p:"\\u8981\\u4e48\\u4e0d\\u662f\\u6211\\u4eec\\u7684\\uff0c\\u8981\\u4e48\\u6c34\\u5370\\u88ab\\u5927\\u5e45\\u7f16\\u8f91/\\u88c1\\u526a\\u7834\\u574f\\u4e86\\u3002",
  back_check:"\\u2190 \\u68c0\\u67e5\\u4e0b\\u4e00\\u5f20",back_try:"\\u2190 \\u6362\\u4e00\\u5f20\\u8bd5\\u8bd5",
  login_h1:"\\u8f93\\u5165\\u5bc6\\u7801",login_wrong:"\\u5bc6\\u7801\\u9519\\u8bef\\u3002",lbl_password:"\\u5bc6\\u7801",btn_enter:"\\u8fdb\\u5165"},
 id:{nav_add:"Tambah watermark",nav_verify:"Verifikasi",
  home_h1:"Lindungi foto Anda",
  home_p:"Unggah satu atau banyak gambar. Setiap gambar diberi logo DADA samar dan watermark forensik tersembunyi, lalu dicatat \\u2014 jadi kalau dicuri, kami bisa buktikan ini milik kami.",
  drag:"Seret gambar ke sini, atau klik untuk memilih",sel:"{n} gambar dipilih",
  lbl_shoot:"Pemotretan / klien",ph_shoot:"mis. Coco \\u2014 Komaneka 16 Jun",
  lbl_note:"Catatan",ph_optional:"opsional",
  lbl_pos:"Posisi logo",pos_br:"Kanan bawah",pos_bl:"Kiri bawah",pos_tr:"Kanan atas",pos_tl:"Kiri atas",pos_center:"Tengah",
  lbl_opacity:"Opasitas logo",lbl_size:"Ukuran logo",
  chk_visible:"tambah logo terlihat (hapus centang untuk tanpa logo)",btn_watermark:"Beri watermark",
  res_done:"Selesai",res_code:"Kode tersembunyi:",btn_download:"Unduh",back_more:"\\u2190 beri watermark lagi",
  res_done_n:"Selesai \\u2014 {n} gambar",btn_zip:"Unduh semua (zip)",not_found:"Tidak ditemukan",back:"\\u2190 kembali",
  ver_h1:"Verifikasi gambar yang dicuri",
  ver_p:"Masukkan foto yang Anda duga diambil dari kami. Kami akan membaca watermark tersembunyi dan memberi tahu dari pemotretan mana asalnya.",
  lbl_suspect:"Gambar yang dicurigai",btn_check:"Periksa",
  ver_ok_h1:"\\u2713 Ini gambar milik DADA",ver_approx:"kecocokan mendekati, beda {n} karakter \\u2014 tetap milik kami",
  ver_matched:"Kode cocok:",ver_shoot:"Pemotretan:",ver_note:"Catatan:",ver_on:"Diberi watermark pada:",
  ver_found_h1:"\\u2713 Watermark DADA ditemukan",ver_found_code:"Kode",
  ver_found_p:"tidak ada di registry ini (diberi watermark di tempat lain?), tapi tandanya terlihat seperti milik kami.",
  ver_none_h1:"\\u2717 Watermark DADA tidak terdeteksi",
  ver_none_p:"Mungkin bukan milik kami, atau watermark rusak karena editing / cropping berat.",
  back_check:"\\u2190 periksa yang lain",back_try:"\\u2190 coba yang lain",
  login_h1:"Masukkan kata sandi",login_wrong:"Kata sandi salah.",lbl_password:"Kata sandi",btn_enter:"Masuk"}
};
function applyLang(l){
 try{localStorage.setItem('wm_lang',l)}catch(e){}
 var D=I18N[l]||I18N.en;
 document.querySelectorAll('[data-t]').forEach(function(el){
  var k=el.getAttribute('data-t'),s=D[k];if(s==null)s=I18N.en[k];if(s==null)return;
  var n=el.getAttribute('data-n');if(n!=null)s=s.replace('{n}',n);el.textContent=s;});
 document.querySelectorAll('[data-tp]').forEach(function(el){
  var k=el.getAttribute('data-tp'),s=D[k];if(s==null)s=I18N.en[k];if(s!=null)el.placeholder=s;});
 document.querySelectorAll('.lang a').forEach(function(a){a.className=(a.getAttribute('data-lang')===l?'on':'');});
 document.documentElement.lang=l;
 if(window._wmUpd){window._wmUpd();}
}
function setLang(l){applyLang(l);}
(function(){var l=null;try{l=localStorage.getItem('wm_lang')}catch(e){}
 if(!l){var nl=(navigator.language||'en').toLowerCase();l=nl.indexOf('zh')===0?'zh':(nl.indexOf('id')===0?'id':'en');}
 applyLang(l);})();
</script>
"""


def page(body: str, active: str = "") -> str:
    def on(n: str) -> str:
        return "on" if active == n else ""
    return f"""<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DADA Watermark</title><style>{STYLE}</style>
<div class="wrap">
  <img class="logo" src="/logo" alt="DADA ISLAND">
  <div class="nav"><a class="{on('add')}" href="/" data-t="nav_add">Add watermark</a><a class="{on('verify')}" href="/verify" data-t="nav_verify">Verify</a></div>
  {body}
</div>
{LANG_SCRIPT}"""


@app.get("/logo")
def logo():
    return FileResponse(os.path.join(BASE, "logo-white.png"), media_type="image/png")


@app.get("/login", response_class=HTMLResponse)
def login_page(bad: int = 0) -> str:
    err = '<p class="bad" data-t="login_wrong">Wrong password.</p>' if bad else ""
    return page(
        f"""<h1 data-t="login_h1">Enter password</h1>{err}
        <div class="card"><form action="/login" method="post">
          <label data-t="lbl_password">Password</label><input type="text" name="password" autofocus>
          <button type="submit" data-t="btn_enter">Enter</button>
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
function upd(){var l='en';try{l=localStorage.getItem('wm_lang')||'en'}catch(e){}
 var s=(window.I18N&&I18N[l]&&I18N[l].sel)||'{n} image(s) selected';
 n.textContent=f.files.length?s.replace('{n}',f.files.length):'';}
window._wmUpd=upd;
d.onclick=function(){f.click()};f.onchange=upd;
['dragover','dragenter'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.add('over')})});
['dragleave','drop'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.remove('over')})});
d.addEventListener('drop',function(ev){f.files=ev.dataTransfer.files;upd()});upd();})();
</script>"""


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return page(
        """<h1 data-t="home_h1">Protect your photos</h1>
        <p data-t="home_p">Add one or many images. Each gets a faint DADA logo and a hidden forensic
        watermark, then it's logged so we can prove it's ours if it's ever stolen.</p>
        <div class="card"><form action="/embed" method="post" enctype="multipart/form-data">
          <input id="file" type="file" name="files" accept="image/*" multiple required style="display:none">
          <div id="drop" class="drop" data-t="drag">Drag images here, or click to choose</div>
          <div id="cnt" style="font-size:12px;color:#8f8f8d;margin-top:.5rem"></div>
          <label data-t="lbl_shoot">Shoot / client</label><input type="text" name="shoot" data-tp="ph_shoot" placeholder="e.g. Coco — Komaneka 16 Jun">
          <label data-t="lbl_note">Note</label><input type="text" name="note" data-tp="ph_optional" placeholder="optional">
          <div class="row">
            <div><label data-t="lbl_pos">Logo position</label>
              <select name="position">
                <option value="br" data-t="pos_br">Bottom-right</option><option value="bl" data-t="pos_bl">Bottom-left</option>
                <option value="tr" data-t="pos_tr">Top-right</option><option value="tl" data-t="pos_tl">Top-left</option>
                <option value="center" data-t="pos_center">Center</option>
              </select></div>
            <div><label data-t="lbl_opacity">Logo opacity</label><input type="range" name="opacity" min="0.2" max="0.9" step="0.05" value="0.55"></div>
            <div><label data-t="lbl_size">Logo size</label><input type="range" name="scale" min="0.1" max="0.4" step="0.02" value="0.2"></div>
          </div>
          <div class="check"><input type="checkbox" name="visible" checked id="v"><label for="v" data-t="chk_visible" style="margin:0;text-transform:none;letter-spacing:0;font-size:13px;color:#cfcfcd">add the visible logo (uncheck for invisible-only)</label></div>
          <button type="submit" data-t="btn_watermark">Watermark</button>
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
        return page('<h1 data-t="not_found">Not found</h1><a class="back" href="/" data-t="back">← back</a>', "add")
    if len(rows) == 1:
        code = rows[0][0]
        body = f"""<h1 data-t="res_done">Done</h1>
        <p><span data-t="res_code">Hidden code:</span> <span class="code">{code}</span></p>
        <p><a class="btn" href="/download/{code}" data-t="btn_download">Download</a></p>
        <img class="prev" src="/download/{code}">
        <a class="back" href="/" data-t="back_more">← watermark more</a>"""
    else:
        items = "".join(
            f'<div class="item"><span>{(r[1] or r[0])}</span><a href="/download/{r[0]}" data-t="btn_download">Download</a></div>'
            for r in rows
        )
        body = f"""<h1 data-t="res_done_n" data-n="{len(rows)}">Done — {len(rows)} images</h1>
        <p><a class="btn" href="/zip/{batch}" data-t="btn_zip">Download all (zip)</a></p>
        <div class="card">{items}</div>
        <a class="back" href="/" data-t="back_more">← watermark more</a>"""
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
        """<h1 data-t="ver_h1">Verify a stolen image</h1>
        <p data-t="ver_p">Drop in a photo you think was taken from us. We'll read the hidden watermark
        and tell you which shoot it's from.</p>
        <div class="card"><form action="/verify" method="post" enctype="multipart/form-data">
          <label data-t="lbl_suspect">Suspected image</label><input type="file" name="file" accept="image/*" required>
          <button type="submit" data-t="btn_check">Check it</button>
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
        approx = "" if dist == 0 else f'<p class="ok" data-t="ver_approx" data-n="{dist}">approximate match, {dist} char(s) off — still ours</p>'
        body = f"""<h1 class="ok" data-t="ver_ok_h1">✓ This is DADA's image</h1>{approx}
        <p><span data-t="ver_matched">Matched code:</span> <span class="code">{best[0]}</span></p>
        <p><span data-t="ver_shoot">Shoot:</span> <b>{best[1] or '—'}</b><br>
        <span data-t="ver_note">Note:</span> {best[2] or '—'}<br>
        <span data-t="ver_on">Watermarked on:</span> {best[3]}</p>
        <a class="back" href="/verify" data-t="back_check">← check another</a>"""
    elif code.startswith("DADA"):
        body = f"""<h1 class="ok" data-t="ver_found_h1">✓ DADA watermark found</h1>
        <p><span data-t="ver_found_code">Code</span> <span class="code">{code}</span>
        <span data-t="ver_found_p">isn't in this registry (watermarked elsewhere?), but the mark looks like ours.</span></p>
        <a class="back" href="/verify" data-t="back_check">← check another</a>"""
    else:
        body = """<h1 class="bad" data-t="ver_none_h1">✗ No DADA watermark detected</h1>
        <p data-t="ver_none_p">Either it isn't ours, or the watermark was destroyed by heavy editing / cropping.</p>
        <a class="back" href="/verify" data-t="back_try">← try another</a>"""
    return page(body, "verify")
