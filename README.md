# DADA Ledger Bot 🧾🤖

挂在你 WhatsApp 群里的智能报账机器人。自动读取群里发的收据照片(含手写)、算出金额、在群里发出报账、同步 Notion,并能直接在群里问它"这个月花了多少"。

- **WhatsApp 接入**:whatsapp-web.js(扫码挂在你手机的 WhatsApp 上)
- **识别 + 问答**:Claude(`claude-opus-4-8`,擅长手写 + 印尼文)
- **存储**:本地 SQLite + 可选 Notion
- **技术栈**:Node.js / TypeScript

---

## 一、准备

需要先装好(只装一次):
- [Node.js](https://nodejs.org/) 20 或更高(命令行输入 `node -v` 能看到版本号即可)
- 一个 Claude API key(在 [console.anthropic.com](https://console.anthropic.com) → API Keys 创建)
- 一部装着 WhatsApp、且加入了目标群的手机

---

## 二、安装

在项目目录里打开终端(PowerShell):

```powershell
npm install
```

（已经装过就跳过。）

---

## 三、配置 `.env`

项目里已经有一个 `.env` 文件(从 `.env.example` 复制来的)。用记事本或 VS Code 打开它,**只需先填一项**:

```
ANTHROPIC_API_KEY=sk-ant-把你的key粘贴到这里
```

其余先保持默认。重点确认这两行默认值:

```
WHATSAPP_GROUP_NAME=DADA - Financial Report Group   # 必须和群名一字不差
DRY_RUN=true                                         # 先只读不发,核对准确度
```

> Notion 暂时不用管,`NOTION_*` 留空即可,等本地验证 OK 再接。

---

## 四、首次启动 + 扫码登录

```powershell
npm run dev
```

终端会弹出一个二维码。用手机:**WhatsApp → 设置 → 已链接的设备 → 链接设备 → 扫这个二维码**。

登录成功后,终端会打印出你所有群的 id,类似:

```
DADA - Financial Report Group  ->  120363012345678901@g.us
```

把 `DADA` 群对应的那串 `xxxx@g.us` 复制,粘到 `.env` 的:

```
WHATSAPP_GROUP_ID=120363012345678901@g.us
```

> 填了 `WHATSAPP_GROUP_ID` 后,锁定的就是这个群,比靠群名匹配更稳。改完按 `Ctrl+C` 停掉,再 `npm run dev` 重启。

---

## 五、干跑验证(DRY_RUN,关键一步)

在 `DRY_RUN=true` 状态下,往群里发一张**真实收据照片**。机器人会读图、识别,然后把结果**打印在终端**(不会发到群里):

```
🧾 Receipt read automatically
*Fuad Flower Shop #02728 (2026-06-06) → DADA*
   • 5× Amaranthus Viridis: 500.000
   _Subtotal: 500.000_
*TOTAL: 500.000 IDR*
(DRY_RUN preview — not actually posted to the group)
```

**核对金额是否和你人工算的一致**,尤其注意千分位(`500.000` 应是五十万,不是 500)。多发几张不同收据测试。

---

## 六、测试问答(不依赖 WhatsApp)

```powershell
npm run ask -- "这个月在 Fuad 花了多少?"
npm run ask -- "How much did we spend this month?"
```

它会基于已入库的收据回答。

---

## 七、转为正式运行(开始真发群消息)

识别都准了之后,把 `.env` 改成:

```
DRY_RUN=false
```

重启 `npm run dev`。从此机器人会:
- 自动读群里新发的收据 → 在群里回发报账 + TOTAL
- 响应群内命令:
  - `/ask <问题>` —— 例:`/ask 这个月一共花了多少?`
  - `/total` —— 本月总额
  - `/help` —— 查看命令

---

## 八、(可选)接入 Notion

1. 到 [notion.com/my-integrations](https://www.notion.com/my-integrations) 建一个 internal integration,拿到 secret。
2. 在 Notion 建一个数据库(账本),列名建议:
   `Name`(标题)、`Date`(日期)、`Vendor`(文本)、`Recipient`(文本)、`Invoice`(文本)、`Total`(数字)、`Items`(文本)、`Confidence`(数字)。
3. 把该数据库「Share」给你的 integration。
4. 从数据库 URL 里复制 database id。
5. 填进 `.env`:
   ```
   NOTION_API_KEY=secret_xxx
   NOTION_DATABASE_ID=xxxxxxxx
   ```
6. 重启。之后每张收据会自动在 Notion 生成一条记录。

---

## 九、(以后)上服务器 7×24

本地跑通后,想做到关电脑也不漏消息,把整个项目搬到一台一直开机的机器(迷你主机 / 小 VPS):
1. 装 Node.js,`npm install`。
2. 拷贝你的 `.env`(注意 `.wwebjs_auth/` 目录也一起带过去,可免重新扫码)。
3. 用 `pm2` 之类的进程守护让它后台常驻:`npm i -g pm2 && pm2 start "npm run start" --name dada-bot`。

---

## Roadmap(规划)

- [x] 读取群里收据照片(含手写、一图多单)→ 自动识别 + 报账
- [x] 本地数据库存储(SQLite)+ 可选 Notion 同步
- [x] 群内自然语言问答(`/ask` `/total`)
- [x] 入群自动自我介绍(英文 + 印尼语)
- [ ] **Phase 2 — 自建网页仪表盘(替代 Notion)**:在现有数据库之上做一个**响应式网页**(电脑 + 手机浏览器通用,无需上架 App Store),自动展示每一笔收据、按月/商家/收件人筛选、总额与图表、导出 Excel。机器人已经把数据存进 `data/ledger.db`,这一步是自然延伸。
- [ ] Phase 3 — 部署到新加坡 VPS,7×24 在线
- [ ] (可选)原生 iOS App

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式启动(改代码自动重启) |
| `npm run start` | 普通启动 |
| `npm run ask -- "问题"` | 命令行测问答 |
| `npm run typecheck` | 检查类型错误 |

## 数据 & 隐私

- 本地数据库:`data/ledger.db`
- 收据图片:`data/images/`
- WhatsApp 登录态:`.wwebjs_auth/`
- `.env`、`data/`、`.wwebjs_auth/` 都已被 `.gitignore` 排除,不会进 git。
