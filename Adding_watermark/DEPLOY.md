# 上线 + Notion 嵌入

## 方案 R:Render(推荐 ✅ 正规域名、免 DNS、免维护)

仓库根目录有 `render.yaml`(Blueprint),把本 app(子目录 `Adding_watermark`)一键部署成 `https://watermark-dada-island.onrender.com`,域名信誉好、手机不拦。

1. 打开 https://render.com,用 **GitHub 登录**,授权访问 `dada-ledger-bot` 私有仓库。
2. **New → Blueprint** → 选这个仓库 → 它读到 `render.yaml`。
3. 提示填 3 个环境变量(都是密钥):
   - `WATERMARK_PASSWORD` = 登录口令(如 `Dada-Island-2026`)
   - `WM_PASSWORD_IMG` = 一个整数(如 `814627395`)— 隐形水印密钥,保密
   - `WM_PASSWORD_WM` = 另一个整数(如 `6093187`)— 同上
4. Deploy。几分钟后给出 `https://watermark-dada-island.onrender.com`。
5. Notion 里 `/embed` 粘这个网址即可。

> 免费档说明:闲置约 15 分钟会休眠,下次打开冷启动约 50 秒;且**无持久磁盘** → 重启后"登记表"会清空(仍能验证"是不是我们的",只是丢失"哪场婚礼"的标签)。要常驻 + 登记表持久,升级到付费档($7/月)并挂 1GB 磁盘、设 `DATA_DIR=/var/data` 即可。

---

## 方案 V:自有 VPS + 子域名(已部署过,持久 / 常驻)

不动 dada-island.com / Squarespace。用免费的 DuckDNS 给一个指向我们 VPS 的子域名,配正规 HTTPS,再作为 Notion embed 嵌进工作区。

> ⚠️ **域名信誉(实测发现)**:`*.duckdns.org` 这类免费动态域名会被部分手机浏览器的安全库**误标为"有风险"**(安卓上可能直接打不开)。桌面 + iOS 一般正常。**生产环境建议改用正规子域名 `watermark.dada-island.com`**:在 dada-island.com 的 DNS 里加一条记录即可(类型 A、主机 `watermark`、值 `207.148.68.180`),不改动网站本身;加好后我重跑 `certbot -d watermark.dada-island.com` 换证书即可。下面的 DuckDNS 步骤作为零成本的起步/备用方案。

## 第 1 步:DuckDNS(你做,约 1 分钟)

1. 打开 https://www.duckdns.org,用 Google / GitHub 登录(免费)。
2. 在输入框填一个名字,例如 `dada-watermark`,点 **add domain**(被占用就换一个,如 `dada-island-wm`)。
3. 在它那一行,把 **current ip** 设成 `207.148.68.180`,点 **update ip**。
4. 把最终域名(如 `dada-watermark.duckdns.org`)告诉我。剩下我做。

## 第 2 步:服务器(我做)

```bash
# 装系统依赖 + 部署代码到 /opt/dada-watermark
apt-get update && apt-get install -y python3-venv nginx
mkdir -p /opt/dada-watermark && # (scp 本项目过去)
cd /opt/dada-watermark && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
pip uninstall -y opencv-python && pip install opencv-python-headless   # 服务器无 GUI,用 headless

# 设密码 + 以 systemd 常驻在本地 8000(独立于 WhatsApp 机器人)
export WATERMARK_PASSWORD='<设一个口令>'
# systemd unit: ExecStart=.../uvicorn app:app --host 127.0.0.1 --port 8000

# Nginx 反代 + Let's Encrypt 证书
certbot --nginx -d dada-watermark.duckdns.org
```

Nginx 反代要点:`location / { proxy_pass http://127.0.0.1:8000; }`,并把上传上限调大:`client_max_body_size 30m;`。

## 第 3 步:嵌进 Notion(我给你操作)

在 Notion 任意页面输入 `/embed` → 粘贴 `https://dada-watermark.duckdns.org` → 完成。员工在 Notion 里直接拖图加水印,登录一次即可。

## 备注

- `WATERMARK_PASSWORD` 必须设(公网工具用的是我们的水印密钥,不能裸奔)。
- DuckDNS 在 Let's Encrypt 的公共后缀名单里,签证书不受共享域名频率限制,稳。
- 水印密钥(`watermark.py` 的 `PASSWORD_IMG`/`PASSWORD_WM`)上线前换成私密值。
