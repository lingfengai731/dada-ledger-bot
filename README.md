# DADA Ledger Bot 🧾🤖

挂在 WhatsApp 群里的智能报账机器人,为 **DADA Island**(巴厘岛婚礼布置 / 花艺)而建。
它自动读取群里发的收据照片(多为手写印尼文)+ 员工随附的文字说明,识别金额、判断归属哪场婚礼、
在群里发出确认摘要,员工回 `ok` 后写入公司现有的 Notion 账本,并能在群里回答"这个月花了多少"。

- **WhatsApp 接入**:whatsapp-web.js(以独立账号 **DADA_BOT** 扫码挂载)
- **识别 + 解析 + 问答**:Claude(`claude-opus-4-8`,擅长手写 + 印尼文 + 视觉)
- **账本**:公司现有 Notion 数据库(系统的唯一真相)+ 本地 SQLite 镜像
- **技术栈**:Node.js / TypeScript,better-sqlite3,pm2

> 现状:**已部署在新加坡 Vultr 服务器上 7×24 运行**(pm2 进程 `dada-bot`),目前指向测试群,验证后切真实 DADA 群上线。

---

## 一、它是怎么工作的(数据流)

```
群里收到 [收据照片] + [文字说明]      （两者作为相邻的不同消息配对)
      │
      ▼
 Vision Agent     收据图 → 结构化(商家/金额/日期)         src/agents/visionAgent.ts
 Message Parser   文字 → 结构化(发票日/婚期/PIC/场地/付款人) src/agents/messageParser.ts
      │            （一条消息可含多笔支出,自动拆分)
      ▼
 mergeToDraft     图 + 文字合并成一条「支出草稿」            src/expense.ts
      ▼
 enrichDraft      ★ 智能补全(见第二节)                    src/schedule/enrich.ts
      ▼
 群内确认摘要  ──  员工回 ok / cancel / 或补充缺失信息
      ▼
 writeExpense     写入 Notion EXPENSES + 本地 SQLite        src/notion/expenses.ts
```

群内命令:`/ask <问题>`、`/total`、`/summary [month]`、`/owed [名字]`、`/undo`(撤销自己上一笔,并归档对应 Notion 行)、`/help`。

确认前的两道防呆:**金额异常**(< 1.000 IDR 疑似漏千分位)和**图太糊**(识别置信度低时提示重拍),都会在摘要里 ⚠️ 提醒。

---

## 二、★ 智能补全(2026-06 升级)

员工写的收据说明经常**缺婚期、缺 PIC、甚至日期写错**。机器人据以下顺序自动补:

1. **场地优先**:认得的场地(komaneka / pandawa / samabe…)⇒ 判定为婚礼。
   场地对应的**日程表日期会压过员工手写的日期**——因为一张 komaneka 的收据不可能属于别处的婚礼。
   > 例:`06/15 mitir 06/15 1.000.000 putu (komaneka)` → 婚期自动修正为 **2026-06-16**、PIC 自动填 **CHRISTI**。
2. **婚礼日程表**(`data/wedding-schedule.csv`):DADA 人工维护的婚礼主表(客户/场地/PIC/日期)。
   按 场地 + 离发票日最近的日期 匹配出是哪场婚礼,补全婚期与 PIC。
   - PIC 映射:`putri→PUTRI`、`Andrian Christi→CHRISTI`、`Jessica Earvin→JAY`、`DĀDA ISLAND→GENERAL`、`ling→LING`。
3. **上下文记忆**(`src/schedule/contextMemory.ts`):14 天滚动记忆。同一天同事发的同场地/同 PIC 单子已含婚期的,
   后面没写婚期的可借用(实现"有人写了、有人没写,机器人自己推断")。
4. **巴厘岛实时日期**:解析以 `Asia/Makassar`(UTC+8)的"今天"为准(`src/util/dates.ts` 的 `baliTodayISO()`)。

### 老板的强制规则(必须满足才允许保存)
> 婚礼支出**必须**同时有 **婚礼日期** 和 **PIC(person in charge,婚礼负责人)**。
> (老板定:用 date + PIC 作硬性要求,而不是 organiser——因为有些婚礼没有 organiser 或员工不知道。)

- 补全后仍缺的,摘要里显示 `???`,且**回 `ok` 也拒绝保存**,提示员工补。
- 员工随后补一句(如 `16/06 christi`)会**合并进原草稿**(不会冲掉已读到的收据),补全后即可 `ok`。
- 非婚礼支出(general / shop)不受此限制。

> ⚠️ 当前婚礼日程表读的是**导出的 CSV 快照**。要做到**实时**读取 Notion 的 WEDDING SCHEDULE,
> 需老板把该 Notion 页面也分享给 `DADA Ledger Bot` 集成;代码已预留,分享后改一处配置即可切实时。

---

## 三、Notion 写入

- **写入目标(固定)**:`INVOICE2026` 数据库 → 数据源 **`EXPENSES 2026`**(id `cec25f1b-255a-8390-b86b-076832d4f087`)。
  与历史账本 `INVOICE` / `EXPENSES`(`27925f1b…`)分开,机器人**从不**写历史账本。
- **API**:Notion 2025-09-03 多数据源 API,`@notionhq/client` v5,
  `pages.create({ parent: { type:'data_source_id', data_source_id } })`。
- **写入的列**:

  | 列 | 来源 |
  |---|---|
  | `VENDOR / DESCRIPTION`(标题) | 说明/商家,**大写**(沿用账本风格) |
  | `COST` 和 `PRICE` | 金额(两列同值,沿用账本风格) |
  | `INVOICE DATE` | 发票/购买日 |
  | `WEDDING DATE` | 婚期(婚礼单才写;经智能补全) |
  | `PIC`(multi_select) | 婚礼负责人 `LING/JAY/CHRISTI/PUTRI/GENERAL`,别名 `jessica/jesicha→JAY` |
  | `HANDLER`(multi_select) | 付款人/待报销人(`by/tf/trf <名字>`) |

- **保证**:婚礼行不会再带空的 `WEDDING DATE` 或 `PIC`(被拦截规则挡住)。
- `preview` 模式只打印不写;`live` 模式真正创建行。由 `.env` 的 `NOTION_WRITE` 控制。

---

## 四、配置 `.env`

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-8

WHATSAPP_GROUP_ID=120363426839508686@g.us   # 测试群;上线改成真实 DADA 群
TRIGGER_MODE=auto                            # 报账专用群:任意收据/金额/日期都视为提交
DRY_RUN=false                                # true=只读不发(本地调试用)

NOTION_API_KEY=ntn_...
NOTION_DATA_SOURCE_ID=cec25f1b-255a-8390-b86b-076832d4f087   # EXPENSES 2026
NOTION_WRITE=live                            # live=真写入;preview=只预览

PROXY_URL=http://127.0.0.1:7890   # 仅中国大陆本地需要(Node 不走系统代理);服务器留空
```

> 中国大陆本地运行必须设 `PROXY_URL`,否则 Anthropic/Notion 会 403。服务器在新加坡,留空直连。

---

## 五、本地运行 / 调试

```powershell
npm install
npm run dev        # 启动(改代码自动重启);首次会弹二维码,用 DADA_BOT 手机扫
```

> ⚠️ **同一个 DADA_BOT 账号同时只能有一个实例**。服务器已在跑时,**不要**本地 `npm run dev`,否则互相挤掉登录。
> 调试解析/补全请用下面的离线 CLI,不会碰 WhatsApp 会话。

### 离线测试 CLI(不发群、不抢会话)

```powershell
npm run typecheck                                  # 类型检查
npx tsx src/cli/eval-schedule.ts                   # 婚礼日程表补全 + 拦截规则(纯离线)
npx tsx src/cli/eval-pipeline.ts "06/15 mitir 06/15 1.000.000 putu (komaneka)"  # 解析+补全全流程
npx tsx src/cli/calibrate.ts "<_chat.txt>" 90 tail               # 在真实聊天记录上批量评估准确率/拦截率
npx tsx src/cli/notion-schema.ts                   # 打印可访问的 Notion 数据源结构
npx tsx src/cli/eval-notes.ts "<导出的 _chat.txt 路径>"   # 在真实聊天记录上跑解析器
npm run ask -- "这个月花了多少?"                    # 命令行问答
```

---

## 六、服务器(已上线)

- 机器:Vultr 新加坡,`207.148.68.180`,Ubuntu 24.04,Node 22 + google-chrome-stable。
- 路径:`/opt/dada-ledger-bot`,进程:pm2 `dada-bot`(`npm run start` → `tsx src/index.ts`),开机自启。
- 管理(从本地用 SSH key):

  ```bash
  ssh -i ~/.ssh/dada_deploy -o StrictHostKeyChecking=no root@207.148.68.180
  pm2 logs dada-bot          # 看日志
  pm2 restart dada-bot       # 重启
  ```

### 更新部署(无新依赖时)

```bash
# 本地:打包 src + 婚礼表快照
tar czf /tmp/dada-update.tgz src data/wedding-schedule.csv
scp -i ~/.ssh/dada_deploy /tmp/dada-update.tgz root@207.148.68.180:/tmp/
# 服务器:解包并重启
ssh -i ~/.ssh/dada_deploy root@207.148.68.180 \
  "cd /opt/dada-ledger-bot && tar xzf /tmp/dada-update.tgz && pm2 restart dada-bot"
```

### 正式上线(切真实 DADA 群)

```bash
ssh ... "cd /opt/dada-ledger-bot && \
  sed -i 's|^WHATSAPP_GROUP_ID=.*|WHATSAPP_GROUP_ID=120363284134868849@g.us|' .env && \
  pm2 restart dada-bot"
```

> 前提:DADA_BOT 已被拉进真实群。进群后机器人会自动发中英双语自我介绍。

---

## 七、Roadmap

- [x] 读群里收据照片(含手写、一图多单)→ 自动识别
- [x] 图 + 文字配对解析(发票日 / 婚期 / PIC / 场地 / 付款人)
- [x] 确认后写入 Notion EXPENSES(invoice2026)+ 本地 SQLite
- [x] 群内自然语言问答(`/ask` `/total`),入群双语自我介绍
- [x] **婚礼日程表智能补全 + 场地优先 + 上下文记忆 + 巴厘岛时间**
- [x] **强制规则:婚期/PIC 缺失显示 `???` 并拒绝保存**
- [x] 部署新加坡 VPS,7×24 在线
- [x] 婚礼日程表**实时**读取(Notion 已分享给集成)
- [x] PDF 发票识别;PIC/HANDLER 选项实时同步;重复/金额异常/糊图防呆;`/undo` 撤销
- [x] 每日备份 + 掉线监控(healthchecks.io)+ 每周自动汇总私发老板
- [ ] (可选)只读网页仪表盘 / 原生 App
- [ ] (评估中)迁移到官方 WhatsApp Business Cloud API(规避非官方自动化被限制/封号的风险)

---

## 八、数据 & 隐私

- 本地账本镜像:`data/ledger.db`;收据图片:`data/images/`
- 婚礼日程表快照:`data/wedding-schedule.csv`(公司私有,**不进 git**)
- WhatsApp 登录态:`.wwebjs_auth/`
- `.env`、`data/`、`.wwebjs_auth/`、聊天导出 均已被 `.gitignore` 排除,不会进 git。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run start` | 普通启动(服务器用) |
| `npm run dev` | 开发模式(改代码自动重启) |
| `npm run typecheck` | 类型检查 |
| `npm run ask -- "问题"` | 命令行问答 |
| `npx tsx src/cli/eval-schedule.ts` | 离线测试婚礼补全 + 拦截 |
| `npx tsx src/cli/eval-pipeline.ts "<说明>"` | 解析 + 补全全流程 |
