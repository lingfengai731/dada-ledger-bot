# DADA Ledger Bot 🧾🤖

挂在 WhatsApp 群里的智能报账机器人,为 **DADA Island**(巴厘岛婚礼布置 / 花艺)而建。
它自动读取群里发的收据照片(多为手写印尼文)+ 员工随附的文字说明,识别金额、判断归属哪场婚礼、
在群里发出确认摘要,员工回 `ok` 后写入公司的 Notion 账本(`AUTO-LEDGER`),还能处理 Ling 的**报销**、
每晚把当天明细私发老板、并在群里回答"这个月花了多少"。

- **WhatsApp 接入**:whatsapp-web.js(以独立账号 **DADA_BOT** 扫码挂载)
- **识别 + 解析 + 问答**:Claude(`claude-opus-4-8`,擅长手写 + 印尼文 + 视觉)
- **账本**:公司现有 Notion 数据库(系统的唯一真相)+ 本地 SQLite 镜像
- **技术栈**:Node.js / TypeScript,better-sqlite3,pm2

> 现状:**已部署在新加坡 Vultr 服务器上 7×24 运行**(pm2 进程 `dada-bot`),目前指向测试群,验证后切真实 DADA 群上线。

> 🔏 **子项目:[DADA Watermark](Adding_watermark/README.md)** —— 给作品图加可见 + 隐形双重水印,防社交平台盗图、可维权(独立的 Python 小网页,详见链接)。

---

## 一、它是怎么工作的(数据流)

```
群里收到 [收据照片(+caption)] 和/或 [文字说明]
      │   5 种发法都认:只发文字 / 图文一条发 / 图文分两条(~10秒内,任意顺序) /
      │   先发图再发"引用那张图"的文字 / 只发图。caption 直接当说明读。
      │   智能收集窗口:一条发全的 ~3 秒就处理;只发了一半则等 ~20 秒凑另一半
      ▼
 Vision Agent     收据图 → 结构化(商家/金额/日期)         src/agents/visionAgent.ts
 Message Parser   文字 → 结构化(发票日/婚期/PIC/场地/付款人) src/agents/messageParser.ts
      │            （一条消息可含多笔支出,自动拆分）
      ▼
 mergeToDraft     图 + 文字合并成一条「支出草稿」            src/expense.ts
      ▼
 enrichDraft      ★ 智能补全(见第三节)                    src/schedule/enrich.ts
      ▼
 群内确认摘要  ──  员工回 ok / cancel / 或补充缺失信息（聊天内容会被忽略,不刷屏）
      ▼
 writeExpense     写入 Notion AUTO-LEDGER + 本地 SQLite      src/notion/expenses.ts
                  （并把收据原图附到 Notion 行的页面正文里）
```

### 群内确认 & 纠错(2026-06 重做)

- **每一笔单独确认**:每条提交各自回一条确认,用固定 **6 字段格式**(Vendor/description、Cost、Invoice date、Wedding date、PIC、Handler)。**不同提交永不合并**,也不会把别人或你上一条的支出粘在一起。
- **一次性连发很多笔**(一条消息多行 / 几秒内连发)才会汇总成**一条带编号的列表**(`1. … 2. …`);老板早上发的 15 笔就是这种。
- **群里不显示 TOTAL**:合计只出现在**每晚私发老板的明细总结**里,群内确认从不算总额。
- **回复**:`ok` 保存(你名下所有待确认都会保存;引用某条只确认那一条)、`cancel` 取消。
- **改某一笔**:对编号列表回 `1. 130000`(改金额)、`3. christi`(设 PIC);只发 `christi` 会给**所有缺 PIC 的行**补上。
- **多人并发不互串**:按各自 WhatsApp id 分别记账;一个人也能同时有多条待确认,各自提醒、各自保存,互不覆盖。

**两条并行支线:**
- **报销**:Ling 发「转账截图 + `Reimbursement <名字>`」→ 视觉读出每笔转账(一图可多笔)→ 写入 `REIMBURSED` 列(不写 COST、不要婚期/PIC)。见 `buildReimbursementDraft`。
- **未确认兜底**:草稿超过 **30 分钟**没回 `ok` → @发件人提醒(每条单独提醒,说明"你的 N 笔");超过 **8 小时** → 信息齐全的自动写入(`sweepPending`)。

群内命令:`/ask <问题>`、`/total`、`/summary [month]`、`/owed [名字]`、`/iam <名字>`(告诉机器人你是谁,提高 handler 判断)、`/pushsummary [today|month]`、`/undo`(撤销自己上一笔,并归档对应 Notion 行)、`/help`。

确认前的防呆:**金额异常**(< 1.000 IDR 疑似漏千分位)、**图太糊**、**疑似重复**,都会在摘要里 ⚠️ 提醒。

---

## 二、员工怎么写(笔记格式)

老板与团队商定的最终格式(2026-07;也贴在群描述里)。**开头先写发票日期**,**东西在「谁付」之前**,结尾 `by <谁付>` 可换成 `for ling payment`:

```
婚礼:   <发票日> wed <婚期> pic <负责人> <金额> <东西> by <谁付>
        例: 15/6 wed 16/6 pic christi 1.500.000 bunga mitir by putu
采购/日常: <发票日> shop <金额> <东西> by <谁付>
        或 <发票日> gen  <金额> <东西> by <谁付>
        例: 15/6 shop 250.000 vase stock by rania
交给 Ling 付: 把结尾 `by <谁付>` 换成 `for ling payment`
        例: 15/6 gen 6.500.000 anggrek supplier bill for ling payment
```

- 关键词(不分大小写):`wed` · `pic` · `shop` · `gen` · `by` · `for ling payment`。
- **金额以员工打的字为准**(发票上数字多:手续费/小计/税,照片只作交叉核对,不一致会 ⚠️ 提醒但用打字金额)。
- 确认消息的标题会带类型(_Please confirm this **WEDDING/SHOP/GENERAL** expense_),分类错了当场能看出来。
- **没写 shop/gen/wed 时怎么分类**:有场地/婚期/PIC 线索 → 判 WEDDING(如 `for 27th Lovina`);毫无线索也默认偏向 WEDDING(业务本性),但会因缺 `wed`/`pic` 卡 `???` 不给保存。**分类错了回一句 `shop` / `gen` 即可翻转**(列表用 `2. shop` 指定行);补 `wed <日期>` 或 `pic <名字>` 则翻回 WEDDING。
- **每笔只报一次**,尽量**附一张**收据/发票照片。

### 成品卡片(贴在群描述里的英文版,员工照抄)

```
📋 DADA — Expense format

One entry per expense.
Attach one receipt/invoice photo.
Start with the invoice date.
End with 'for ling payment' if Ling pays the bill.

Wedding:
<inv date> wed <wedding date> pic <name> <amount> <item> by <who paid>
e.g. 15/6 wed 16/6 pic christi 1.500.000 bunga mitir by putu

Shop / General:
<inv date> shop <amount> <item> by <who paid>
<inv date> gen <amount> <item> by <who paid>
e.g. 15/6 shop 250.000 vase stock by rania

Keywords: wed · pic · shop · gen · by · for ling payment
```

> 机器人的**自我介绍**(进群自动发,`/help` 也会触发)已内置同一模板,英文 + 印尼语双语,见 `src/whatsapp/bot.ts` 的 `INTRO_MESSAGE`。改模板时记得三处同步:群描述卡片、`INTRO_MESSAGE`、解析提示词(`src/agents/messageParser.ts`)。
- 婚礼单**务必**写 `wed` + `pic`;名字:`Ling / Jay / Christi / Putri`(**Jay = Jessica**)。发票日读不到照片时,开头手写的日期兜底。
- 照片**带 caption 一条发**最方便;分两条发(照片 + 文字)也能拼上。
- **报销(Ling 打款给员工)**:发转账截图 + 一句 `Reimbursement <名字>`,一张截图含多笔也行。

## 三、★ 智能补全(2026-06 升级)

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

## 四、Notion 写入

- **写入目标(固定)**:页面 **`AUTO-LEDGER`**(原 `invoice2026` 改名而来)→ 数据源 **`EXPENSES 2026`**(id `cec25f1b-255a-8390-b86b-076832d4f087`)。
  与历史账本 `INVOICE` / `EXPENSES`(`27925f1b…`)分开,机器人**从不**写历史账本。
- **API**:Notion 2025-09-03 多数据源 API,`@notionhq/client` v5,
  `pages.create({ parent: { type:'data_source_id', data_source_id } })`。
- **写入的列**:

  | 列 | 来源 |
  |---|---|
  | `VENDOR / DESCRIPTION`(标题) | 商家 + 说明合并、去重(商家已含在说明里就不重复),**大写** |
  | `COST` 和 `PRICE` | 金额(普通支出;两列同值,沿用账本风格) |
  | `REIMBURSED` | 报销金额(报销单才写;此时 COST 留空) |
  | `INVOICE DATE` | 发票/购买日(**优先从收据图读**;空着不挡保存) |
  | `WEDDING DATE` | 婚期(婚礼单才写;经智能补全) |
  | `PIC`(multi_select) | 婚礼负责人 `LING/JAY/CHRISTI/PUTRI/GENERAL`,别名 `jessica/jesicha→JAY` |
  | `HANDLER`(multi_select) | 付款人/待报销人(`by/tf/trf <名字>`,或报销的收款人) |
  | `For Ling Payment?`(checkbox) | 说明里含 `for ling payment` / `to be paid by ling` 时勾选(供应商账单由 Ling 自付) |
  | `EXPENSE TYPE`(select) | 机器人按判定自动填 `Wedding` / `Shop` / `General`(报销行留空,靠 REIMBURSED 区分);选项实时同步 |

> 📌 **结构变更(2026-07)**:AUTO-LEDGER 与 INVOICE 已移到共享的 **ADMIN** 空间;数据源 id **未变**,API 仍正常。`Ling Paid Date`(date)由 Ling 付款后**手动**填写,机器人不碰。

- **收据原图**:写入成功后,把收据照片/PDF 作为图片/PDF 块**附到该 Notion 行的页面正文**(best-effort,失败不影响存账;开关 `NOTION_ATTACH_RECEIPTS`)。
- **报销约定**(对齐历史账本):标题就是 `REIMBURSEMENT`、人名放 `HANDLER`、金额放 `REIMBURSED`。
- **保证**:婚礼行不会再带空的 `WEDDING DATE` 或 `PIC`(被拦截规则挡住)。
- `preview` 模式只打印不写;`live` 模式真正创建行。由 `.env` 的 `NOTION_WRITE` 控制。

---

## 五、配置 `.env`

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=auto                          # auto=启动时自动选最新最强的 Opus;也可写死如 claude-opus-4-8

WHATSAPP_GROUP_ID=120363426839508686@g.us   # 测试群;上线改成真实 DADA 群 120363284134868849@g.us
WA_PAIR_NUMBER=8613078287710                 # 机器人自己的号;设了就能用"手机号配对码"远程连号(免扫二维码)
TRIGGER_MODE=auto                            # 报账专用群:任意收据/金额/日期都视为提交
DRY_RUN=false                                # true=只读不发(本地调试用)

NOTION_API_KEY=ntn_...
NOTION_DATA_SOURCE_ID=cec25f1b-255a-8390-b86b-076832d4f087   # AUTO-LEDGER / EXPENSES 2026
NOTION_WEDDING_DATA_SOURCE_ID=27925f1b-255a-80d9-9c31-000ba1bdd7bf  # WEDDING SCHEDULE(实时读)
NOTION_WRITE=live                            # live=真写入;preview=只预览
NOTION_ATTACH_RECEIPTS=true                  # 把收据原图附到 Notion 行(默认开)

# 每晚账单私发老板(Ling)
BOSS_WHATSAPP_ID=6281246337205
SUMMARY_CADENCE=daily                         # daily=每天 / weekly / monthly
SUMMARY_HOUR=22                               # 巴厘时间几点发

PROXY_URL=http://127.0.0.1:7890   # 仅中国大陆本地需要(Node 不走系统代理);服务器留空
```

> 中国大陆本地运行必须设 `PROXY_URL`,否则 Anthropic/Notion 会 403。服务器在新加坡,留空直连。

---

## 六、本地运行 / 调试

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

## 七、服务器与部署

- 机器:Vultr 新加坡,`207.148.68.180`,Ubuntu 24.04,Node 22 + google-chrome-stable。
- 路径:`/opt/dada-ledger-bot`(一个连到 `origin` 的 git 仓库),进程:pm2 `dada-bot`(`npm run start` → `tsx src/index.ts`),开机自启。
- **登录方式**:VPS 没有 GitHub 凭据,也没给本地配 SSH key —— 运维从 **Vultr 网页 noVNC 控制台**或自己电脑的 PowerShell `ssh root@207.148.68.180`(用 root 密码)登录。noVNC **不能粘贴**,命令要手打。

### 更新部署

仓库是 **private**,VPS 上 `git pull` 需先在 GitHub 把仓库临时设为 **public**,拉完再设回 private:

```bash
cd /opt/dada-ledger-bot
git pull origin main
npm install            # 仅当有新依赖时
pm2 restart dada-bot
pm2 logs dada-bot --lines 20   # 看到 "WhatsApp client ready ✅" 即成功
```

> 重启**不需要重新扫码**(`.wwebjs_auth` 是未跟踪文件,`git reset/pull` 不会动它)。新表/新列在启动时自动建/迁移。

### 用手机号配对码连号 / 重连(免扫二维码)

会话掉了、或第一次连号时,在 noVNC 里也能连——用 8 位**配对码**比扫码省事:

```bash
cd /opt/dada-ledger-bot
echo 'WA_PAIR_NUMBER=8613078287710' >> .env   # 机器人自己的号(只需加一次)
git pull origin main
pm2 restart dada-bot
pm2 logs dada-bot --raw                        # 等日志刷出 8 位配对码(形如 ABCD-1234)
```

然后在**机器人手机**上:WhatsApp → 设置 → 已链接的设备 → 链接设备 → **「改用电话号码链接」** → 输入那 8 位码(忽略中间的横杠)。看到 `WhatsApp client ready ✅` 后按 `Ctrl+C` 退出日志。

> ⚠️ 配对码几分钟内有效;过期或没出来就 `pm2 restart dada-bot` 再看一次。**只连一次**,别反复试(WhatsApp 会因频繁连接临时限制账号)。`.env` 里 `WA_PAIR_NUMBER` 加过一次后就别重复 `echo` 了。

### 正式上线 / 切群

1. 让管理员把 **DADA_BOT** 拉进目标群(进群后机器人会自动发中/英/印尼三语自我介绍;若漏发,群里打 `/help` 即可)。
2. VPS 上切目标群并重启:

```bash
cd /opt/dada-ledger-bot
sed -i 's|^WHATSAPP_GROUP_ID=.*|WHATSAPP_GROUP_ID=120363284134868849@g.us|' .env   # 真实 DADA 群
pm2 restart dada-bot
```
3. `pm2 logs dada-bot --lines 12` 确认 `target` 是真群 id。

> 机器人启动时会把"自己所在的所有群 → id"打印在日志里,方便核对群 id。

---

## 八、功能清单(已做 / 没做)

### ✅ 已做

| 模块 | 功能 |
|---|---|
| 识别 | 收据照片(含手写、一图多单、PDF)→ 结构化;图 + 文字配对(发票日/婚期/PIC/场地/付款人) |
| 发送方式 | 5 种发法都认(只文字 / 图文一条 / 图文分两条 / 引用照片的文字 / 只发图) |
| 多笔提交 | 一条多行、或一次连发 15+ 笔都能稳;**每笔单独确认**,连发才汇总成编号列表 |
| 确认格式 | 固定 **6 字段**;**群内不显示 TOTAL**(合计只进每晚老板总结) |
| 纠错 | 按行改(`1. 130000` / `3. christi`);`christi` 给所有缺 PIC 的行补全 |
| 多人并发 | 按各自 id 分别记账,互不串、互不覆盖;一人可同时多条待确认 |
| 智能补全 | 婚礼日程表 + **场地优先** + 14 天上下文记忆 + 巴厘岛时间 |
| 强制规则 | 婚礼支出缺婚期/PIC 显示 `???` 并拒绝保存 |
| 报销 | 转账截图 → `REIMBURSED` 列(一图多笔、人名进 HANDLER) |
| Ling 自付 | 说明含 `for ling payment` → 勾选 `For Ling Payment?`,照常进 AUTO-LEDGER,供 Ling 筛选自付 |
| 模型 | `ANTHROPIC_MODEL=auto` 启动时自动选最新最强 Opus(不写死版本) |
| 写入 Notion | AUTO-LEDGER + 本地 SQLite;**收据原图附到 Notion 行**;婚礼日程表实时读取 |
| 兜底 | 30 分钟 @ 提醒 + 8 小时信息齐全自动写入;待确认时忽略闲聊不刷屏 |
| 老板总结 | **每晚明细账单**(分支出/报销 + 当日 TOTAL)私发 Ling |
| 问答/命令 | `/ask` `/total` `/summary` `/owed` `/iam` `/pushsummary` `/undo` `/help`;入群三语自我介绍 |
| 防呆 | 金额异常(疑似漏千分位)/ 糊图 / 疑似重复 ⚠️ 提醒 |
| 运维 | 部署 VPS,7×24 在线(pm2);**手机号配对码**(`WA_PAIR_NUMBER`)远程连号,免扫码 |

### ⬜ 没做 / 评估中

| 状态 | 事项 |
|---|---|
| 评估中 | 用 👍 表情确认以进一步减少消息(等 Ling 拍板) |
| 可选 | 只读网页仪表盘 / 原生 App |
| 评估中 | 迁移到官方 WhatsApp Business Cloud API(规避非官方自动化被限制/封号风险) |

---

## 九、功能验收测试(部署后在测试群跑一遍)

> 用**非机器人账号**发(机器人忽略自己账号的消息)。只发文字时要等 ~20 秒收集窗 + 解析 ~15 秒,总共 30-40 秒回复是正常的。EXPENSE TYPE / For Ling Payment 的**落库结果**要去 Notion AUTO-LEDGER 看列值,群里只显示类型标题。

| # | 功能 | 你发什么 | 预期 |
|---|---|---|---|
| 1 | 婚礼(标准格式) | `15/6 wed 16/6 pic christi 1.500.000 bunga mitir by putu` | 标题 _confirm this **WEDDING** expense_;6 字段全对;Notion `EXPENSE TYPE=Wedding` |
| 2 | Shop | `15/6 shop 250.000 vase stock by rania` | 标题 **SHOP**;婚期/PIC 为 `—`;Notion `EXPENSE TYPE=Shop` |
| 3 | Gen | `15/6 gen 80.000 office snacks by putu` | 标题 **GENERAL**;Notion `EXPENSE TYPE=General` |
| 4 | Ling 自付 | `15/6 gen 6.500.000 anggrek supplier bill for ling payment` | 显示 `💰 For Ling to pay: yes`;`ok` 后 Notion `For Ling Payment?` 打勾 |
| 5 | 打字金额优先 | 转账截图(含手续费)+ 文字金额写含费总额 | **用打字金额**;差额出 ⚠️ `using your typed amount` |
| 6 | 图+文一条发 | 收据照片,caption 写 #1 那行 | ~3 秒快速回,拼成一笔 |
| 7 | 图文分开 | 先发照片,10 秒内再发文字(顺序随意) | 拼成一笔 |
| 8 | 引用照片 | 发照片→隔一会→**引用**它发文字 | 拼进那张照片,不重复记账 |
| 9 | 只发图 | 只发收据照片 | 从图读金额/日期出确认 |
| 10 | 连发多笔 | 一条消息贴 3-15 行 | **一条编号列表**(每行带类型),无 TOTAL |
| 11 | 按行纠错 | 对列表回 `1. 130000` / `3. christi` | 只改那一行,重发摘要 |
| 12 | 补缺 | 缺 PIC 时回 `christi` | 所有缺 PIC 的行补上(已有的不动) |
| 13 | 缺必填拦截 | 婚礼单不写 wed/pic | 显示 `???`;回 `ok` 拒绝保存 |
| 14 | 确认/取消/撤销 | `ok` / `cancel` / `/undo` | 保存全部 / 丢弃 / 撤销上一笔并归档 Notion 行 |
| 15 | 报销 | 转账截图 + `Reimbursement christi` | 💸 报销确认;金额进 `REIMBURSED`;标题 `REIMBURSEMENT` |
| 16 | 重复防呆 | 同一笔发两遍 | 第二遍 ⚠️ 疑似重复 |
| 17 | 忽略闲聊 | 有待确认时发闲聊 | 不回应、不刷屏 |
| 18 | 命令 | `/help` `/total` `/ask 这个月花了多少` `/iam putu` | 各自正确回复 |
| 19 | 30 分钟提醒 | 不回 `ok` 等 30-45 分钟 | @发件人,引用原摘要,一次 |
| 20 | 8 小时自动存 | 信息齐全不回 `ok` 放 8 小时 | 自动写入并在群里通告(信息不全则提醒) |
| 21 | 每晚老板总结 | `/pushsummary today` 模拟 | 私发 Ling 当日明细 + TOTAL |
| 22 | 日程表纠错 | 婚期写错但场地在日程表上 | ℹ️ `Wedding date adjusted to <日期> at <场地>. Correct me if wrong.` |

> 建议顺序:1-5(本轮新行为)→ 10-14(批量+纠错)→ 其余抽查;19/20 挂着等即可。

---

## 十、数据 & 隐私

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
