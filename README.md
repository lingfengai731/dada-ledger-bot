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
- **回复**(老板定版):`ok` = 只确认**最近一笔**;**引用**某条确认消息再回 `ok` = 只确认那一条;`ok all` / `all ok` = 确认你名下全部。`cancel` 同理;引用原 invoice、机器人确认摘要、或 30 分钟提醒再回 `cancel` 都只删那一笔;`cancel all` 全取消。
- **Saved 回执带引用**:`✅ Saved to Notion.` 会优先**引用最初那条提交消息**;如果 WhatsApp Web 找不到原消息,退回引用机器人确认摘要,再不行才引用这次 `ok`,避免无引用回执(`ok all` 时每笔各回一条)。
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

Confirming:
ok — save your latest one
quote one + ok — save that one
ok all — save all yours
cancel / cancel all — discard instead
```

> 报销格式**不进卡片**(老板:只有 Ling 用,员工不需要);但保留在机器人自我介绍里。

> 机器人的**自我介绍**(进群自动发,`/help` 也会触发)已内置同一模板,英文 + 印尼语双语,见 `src/whatsapp/bot.ts` 的 `INTRO_MESSAGE`。改模板时记得三处同步:群描述卡片、`INTRO_MESSAGE`、解析提示词(`src/agents/messageParser.ts`)。
- 婚礼单**务必**写 `wed` + `pic`;名字:`Ling / Jay / Christi / Putri`(**Jay = Jessica**)。发票日读不到照片时,开头手写的日期兜底。
- 照片**带 caption 一条发**最方便;分两条发(照片 + 文字)也能拼上。
- **报销(Ling 打款给员工;只有 Ling 用)**:`reimbursement <员工名>` + 转账截图(一张截图含多笔也行;纯文字也能记,如 `14/6 reimbursement to putri 50000`)。金额/日期从截图读,截图没日期就用**发进群当天**;**PIC 恒为 LING、HANDLER=被报销的员工**,金额进 `REIMBURSED`,标题 `REIMBURSEMENT <名字>`,`EXPENSE TYPE=Reimbursement`。
- **发错了怎么删**:引用发错的原消息、机器人的确认摘要、或 30 分钟 `⏰ please confirm` 提醒,回一句含 `cancel` 的话(如 `cancel unsaved expenses`)即可只删那一笔;单发 `cancel` 删最近一笔;`cancel all` 取消你名下全部待确认。
- **改金额**:直接回一个**纯数字**(如 `1.132.500`)= 修正当前显示那笔的金额,不会被当成新账。

## 三、★ 智能补全(2026-06 升级)

员工写的收据说明经常**缺婚期、缺 PIC、甚至日期写错**。机器人据以下顺序自动补:

1. **场地优先**:认得的场地(komaneka / pandawa / samabe…)⇒ 判定为婚礼。
   场地对应的**日程表日期会压过员工手写的日期**——因为一张 komaneka 的收据不可能属于别处的婚礼。
   > 例:`06/15 mitir 06/15 1.000.000 putu (komaneka)` → 婚期自动修正为 **2026-06-16**、PIC 自动填 **CHRISTI**。
2. **婚礼日程表**(优先实时读 Notion `WEDDING SCHEDULE`,失败才回退 `data/wedding-schedule.csv` 快照):DADA 人工维护的婚礼主表(客户/场地/PIC/日期)。
   按 场地 + 离发票日最近的日期 匹配出是哪场婚礼,补全婚期与 PIC;实时 Notion 模式还能拿到婚礼页 id,用于自动填 `WEDDING` 关系列。
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

> 当前生产配置应使用**实时 Notion 日程表**(`NOTION_WEDDING_DATA_SOURCE_ID` + 页面已分享给 `DADA Ledger Bot` 集成)。CSV 只作为离线兜底;如果日志里没有 `wedding schedule refreshed LIVE from Notion`,先检查 Notion 页面分享和 `.env` 配置。

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
  | `COST` | 金额(普通支出;原重复的 `PRICE` 列老板已删,只写 COST) |
  | `REIMBURSED` | 报销金额(报销单才写;此时 COST 留空) |
  | `INVOICE DATE` | 发票/购买日(**优先从收据图读**;空着不挡保存) |
  | `WEDDING DATE` | 婚期(婚礼单才写;经智能补全) |
  | `PIC`(multi_select) | 婚礼负责人 `LING/JAY/CHRISTI/PUTRI/GENERAL`,别名 `jessica/jesicha→JAY` |
  | `HANDLER`(multi_select) | 付款人/待报销人(`by/tf/trf <名字>`,或报销的收款人) |
  | `For Ling Payment?`(checkbox) | 说明里含 `for ling payment` / `to be paid by ling` 时勾选(供应商账单由 Ling 自付);此时 **HANDLER 自动 = LING** |
  | `EXPENSE TYPE`(select) | 机器人按判定自动填 `Wedding` / `Shop` / `General` / `Reimbursement`;选项实时同步 |

> 📌 **结构变更(2026-07)**:AUTO-LEDGER 与 INVOICE 已移到共享的 **ADMIN** 空间;数据源 id **未变**,API 仍正常。`Ling Paid Date`(date)由 Ling 付款后**手动**填写,机器人不碰。

- **婚礼关系列自动连(2026-07)**:婚礼支出写入时,`WEDDING` 关系列会**自动**连到 WEDDING SCHEDULE 里"同婚期(+PIC 消歧)"的那场婚礼——Notion 里就能按项目 rollup 汇总总花费(老板加的列)。前提是婚礼日程表能**实时读**到婚礼页 id(`NOTION_WEDDING_DATA_SOURCE_ID` 已配 + 页面分享给集成);CSV 快照没有 page id 则跳过。列名用 `NOTION_WEDDING_RELATION_PROP` 配(默认 `WEDDING`,留空关闭),best-effort,连不上不影响存账。
- **收据原图**:写入成功后,把收据照片/PDF 作为图片/PDF 块**附到该 Notion 行的页面正文**(best-effort,失败不影响存账;开关 `NOTION_ATTACH_RECEIPTS`)。
- **报销约定**(老板 2026-07 定版):标题 `REIMBURSEMENT <员工名>`、**`PIC` 恒为 LING、`HANDLER` = 被报销的员工**、金额进 `REIMBURSED`、`EXPENSE TYPE=Reimbursement`、发票日取截图日期(没有则取发进群当天)。保存回执只说 `✅ Saved to Notion.`(不带数量)。
- **保证**:婚礼行不会再带空的 `WEDDING DATE` 或 `PIC`(被拦截规则挡住)。
- `preview` 模式只打印不写;`live` 模式真正创建行。由 `.env` 的 `NOTION_WRITE` 控制。

---

## 五、配置 `.env`

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=auto                          # auto=启动时自动选最新最强的 Opus;也可写死如 claude-opus-4-8
ANTHROPIC_PARSE_MODEL=claude-sonnet-4-6       # 读文字说明用的快模型(读图仍用上面的);设 main 则全用主模型
COLLECT_WAIT_MS=12000                         # 图文分开发时等配对的毫秒数(默认 12 秒;符合模板的消息不等,~3 秒直接处理)

WHATSAPP_GROUP_ID=120363428168476822@g.us   # testing 副群/测试群;频道 2 时仍保留为互动/审计群
WA_PAIR_NUMBER=8613078287710                 # 机器人自己的号;设了就能用"手机号配对码"远程连号(免扫二维码)
TRIGGER_MODE=auto                            # 报账专用群:任意收据/金额/日期都视为提交
DRY_RUN=false                                # true=只读不发(本地调试用)
HUMANIZE_REPLIES=true                         # 回复前标记已读+显示"正在输入…"+随机等几秒(≤6s),更像真人降低封号指纹;只改时机,不改内容/不影响准确率;false 关闭

# Channel 2: 主群静默采集（可选,默认关闭）
# WHATSAPP_GROUP_ID 继续作为频道 1: 互动/测试/审计群,原有 ok 确认流程不变。
# MAIN_SILENT_GROUP_ID 是正式工作群:机器人只读、直接写 Notion、不在该群发言。
# AUDIT_GROUP_ID 是副群/测试群:只收到 "07/17 10:05 Saved to Notion." 这类状态回执。
MAIN_SILENT_GROUP_ID=
AUDIT_GROUP_ID=120363428168476822@g.us
MAIN_SILENT_AUTOSAVE=false                    # 确认主群 id 后再改 true;信息缺 wedding date/PIC 时不会写入,只在副群提示

NOTION_API_KEY=ntn_...
NOTION_DATA_SOURCE_ID=cec25f1b-255a-8390-b86b-076832d4f087   # AUTO-LEDGER / EXPENSES 2026
NOTION_WEDDING_DATA_SOURCE_ID=27925f1b-255a-80d9-9c31-000ba1bdd7bf  # WEDDING SCHEDULE(实时读)
NOTION_WEDDING_RELATION_PROP=WEDDING          # EXPENSES 上"关联到婚礼"的关系列名;自动回填(需实时读到婚礼页 id);留空关闭
NOTION_WRITE=live                            # live=真写入;preview=只预览
NOTION_ATTACH_RECEIPTS=false                 # 只写 Notion 行,不把收据原图附到页面正文;要附图再改 true

# 每晚账单私发老板(Ling)
BOSS_WHATSAPP_ID=6281246337205
SUMMARY_CADENCE=daily                         # daily=每天 / weekly / monthly
SUMMARY_HOUR=22                               # 巴厘时间几点发

# 监控 / 自愈
HEALTHCHECK_URL=https://hc-ping.com/xxxx      # 连着就每 5 分钟 ping 一次;停 ping = healthchecks.io 报 down
HEAL_AFTER_UNREACHABLE=3                       # 会话崩(getState 抛错)连续 N 次(每次隔 5 分钟)就自动 exit,让 pm2 拉起重连(不用扫码);默认 3=约 15 分钟

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

### 浏览器扫码远程重连(配对码失效时的可靠兜底)★

配对码**经常出不来**:启动时 puppeteer 常报 `Failed to add page binding … already exists`,页面一崩,`requestPairingCode` 就拿不到执行上下文 → 退回二维码;而 noVNC 终端里的 ASCII 二维码手机又扫不动。这时用这招——**服务器把二维码和可用的 8 位配对码发布成网页,用自己电脑浏览器打开、手机扫码或输码**,实测最稳。代码已在每次二维码刷新时把原始串写到 `data/last-qr.txt`,成功拿到配对码时写到 `data/last-pairing-code.txt`;`./ops/relink-qr.sh` 会把它们渲染成网页。

**一次性准备**(装一次即可):

```bash
apt install -y qrencode
ufw allow 8080            # 若服务器用 ufw;另去 Vultr 后台 Firewall 也放行 TCP 8080
```

**每次掉线重连(0→1;背景任务上次 kill 了没关系,每次重新起):**

1. 干净重启——消除 puppeteer 崩溃、让它重新刷二维码:

```bash
cd /opt/dada-ledger-bot
pm2 stop dada-bot
pkill -f chrome; pkill -f puppeteer     # 杀掉残留 headless Chrome(崩溃根源)
rm -rf .wwebjs_cache                     # 只删网页版缓存,安全;专治 "already exists"
pm2 restart dada-bot
```

2. 确认在刷二维码(`last-qr.txt` 由机器人每次刷新时写):

```bash
ls -l data/last-qr.txt                   # 有内容即可(pm2 logs 看一眼也行,Ctrl+C 退出不停机器人)
```

3. 一条命令把二维码发布成网页(脚本会循环更新图片——二维码 ~20 秒换一次):

```bash
./ops/relink-qr.sh
```

4. 在**自己电脑浏览器**打开(注意**不要**带尖括号):

   ```
   http://207.148.68.180:8080/
   ```

   页面会同时显示**清晰二维码**和**Pairing code(如果 WhatsApp 成功发出)**。优先试配对码:机器人手机 WhatsApp → 已链接的设备 → 链接设备 → `Link with phone number instead` → 输入页面上的 8 位码;没有配对码或失败时就直接扫二维码。

5. 看到 `WhatsApp client ready ✅` 即成功,清理:

```bash
# 在跑 ./ops/relink-qr.sh 的那个终端按 Ctrl+C
```

> ⚠️ 二维码约 20-30 秒换一次;手机提示失效就**刷新浏览器**再扫(脚本会持续更新图片)。
> `./ops/relink-qr.sh` 必须一直开着才有网页;`pm2 logs` 只是"看日志",关掉它不影响机器人后台运行——只有 `pm2 stop/restart/delete` 才动机器人。
> 打不开网页(转圈/超时):多半是 8080 被防火墙挡了,回去做"一次性准备"里的放行;也可临时换端口:`PORT=8081 ./ops/relink-qr.sh`。

### 本地 Windows 兜底运行(官方 Web 能连、VPS 机器人不能连时)

如果新号在你自己电脑的 `https://web.whatsapp.com` **可以正常 link**,但 VPS/headless 机器人一直提示 `can't link new devices right now`,说明问题很可能是 VPS 数据中心 IP / headless Chrome / puppeteer 环境触发风控。此时可以临时让**自己电脑充当机器人主机**。

> 重要:本地跑机器人仍然需要 WhatsApp linked device。它不能直接复用你普通浏览器里已经登录的 WhatsApp Web 会话;机器人会开一个独立 Chrome/Edge profile。区别是:它在你的本机网络和可视浏览器里 link,通常比 VPS/noVNC/headless 更容易成功。

1. 先停 VPS,避免两个机器人同时回同一个群:

```bash
cd /opt/dada-ledger-bot
pm2 stop dada-bot
```

2. 在 Windows 本机 PowerShell:

```powershell
cd E:\Agentfinance
git pull origin main
npm install
powershell -ExecutionPolicy Bypass -File .\ops\windows-start-bot.ps1
```

脚本会自动:
- 使用可视 Chrome/Edge (`PUPPETEER_HEADLESS=false`)
- 使用独立本地登录态 `.wwebjs_auth_local`
- 禁用 pairing-code 请求(`WA_PAIR_NUMBER=''`),直接扫可视浏览器 QR,避开 flaky `requestPairingCode`

3. 如果扫错号/要换号,只清本地登录态:

```powershell
cd E:\Agentfinance
powershell -ExecutionPolicy Bypass -File .\ops\windows-reset-local-wa-auth.ps1
powershell -ExecutionPolicy Bypass -File .\ops\windows-start-bot.ps1
```

4. 本地长期运行注意:
- 电脑不能睡眠/断网;PowerShell 窗口要保持开着。
- `.env` 仍然要指向正确 `WHATSAPP_GROUP_ID`、Notion、Anthropic key。
- 本地测试通过后,先发 `15/6 gen 50000 test by putu`,再回 `ok`,确认 `✅ Saved to Notion.`。
- 以后若 VPS 账号/link 恢复,先 `Ctrl+C` 停本地机器人,再 `pm2 restart dada-bot`。

### 换机器人账号 / 换群 ID

怀疑旧机器人号被 WhatsApp 风控标记时,可以换一个 WhatsApp 账号重新 linked device。**不需要改代码**,只改 VPS `.env` 和登录态。

这次新账号 / 新群示例:

```text
机器人手机号: +628213819236  →  WA_PAIR_NUMBER=628213819236
新群 ID:      120363284134868849@g.us
```

在 VPS 上:

```bash
cd /opt/dada-ledger-bot

pm2 stop dada-bot

# 换号必须移走旧登录态;先备份,不要直接删
mv .wwebjs_auth ".wwebjs_auth.old.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
rm -rf .wwebjs_cache

# 改新机器人手机号和新群 id
sed -i 's/^WA_PAIR_NUMBER=.*/WA_PAIR_NUMBER=628213819236/' .env
sed -i 's/^WHATSAPP_GROUP_ID=.*/WHATSAPP_GROUP_ID=120363284134868849@g.us/' .env
sed -i 's/^WHATSAPP_GROUP_NAME=.*/WHATSAPP_GROUP_NAME=/' .env   # 最稳:只按 group id 匹配

# 如果 .env 里原来没有这两行,追加
grep -q '^WA_PAIR_NUMBER=' .env || echo 'WA_PAIR_NUMBER=628213819236' >> .env
grep -q '^WHATSAPP_GROUP_ID=' .env || echo 'WHATSAPP_GROUP_ID=120363284134868849@g.us' >> .env

pm2 restart dada-bot
./ops/relink-qr.sh
```

打开 `http://207.148.68.180:8080/`,优先输入网页上的 pairing code;没有或失败就扫二维码。连上后测试:

```text
15/6 gen 50000 test by putu
```

> 注意:新 WhatsApp 账号必须已经被拉进目标群;换的是机器人账号,不是 Notion/账本。`.wwebjs_auth` 绑定旧账号,换号必须移走它。新号最好先真人养号几天(头像/名字/正常聊天),不要刚注册就高频自动化。

### 连接状态排障:linked 但 bot/health down

#### 1. 目标群 ID 配了,但 `Groups the bot is in` 没出现

这通常不是代码问题,而是**当前 linked 的 WhatsApp 账号并没有真正加入目标群**。`.env` 里 `WHATSAPP_GROUP_ID=120...@g.us` 只代表"机器人想监听哪个群";它不能让账号自动进群。

排查:

```bash
pm2 logs dada-bot --lines 80 --nostream
```

看两处:
- `target: "120363284134868849@g.us"`:说明 `.env` 配置目标群正确。
- `Groups the bot is in`:这是**当前账号实际加入的群**。如果没有 `...8849@g.us`,说明账号没进群或群 ID 抄错。

最稳修复:
1. 拿当前 linked 的机器人手机,确认 WhatsApp 聊天列表里能看到目标群。
2. 如果看不到,让群管理员用"添加参与者"直接把 `+628213819236` 加进群,不要只发邀请链接。
3. 加完后不需要重新扫码,直接:

```bash
pm2 restart dada-bot
pm2 logs dada-bot --lines 80 --nostream
```

#### 2. 手机显示 linked device,但机器人 `OPENING` / healthchecks.io down

手机里"已连接设备"只说明 WhatsApp 服务器端还保留这个设备记录,不代表机器人进程已经进入 `ready`。有时 whatsapp-web.js 会卡在 `OPENING`:既没成功,也没明确断开,所以库内置的自动重连不会触发;healthcheck 也不会 ping,就会显示 down。

先看完整日志:

```bash
pm2 status
pm2 logs dada-bot --lines 300 --nostream | grep -A 5 -i "error\|conflict\|closed\|banned\|restrict\|OPENING"
```

如果没有明确封号/限制,只是长期 `OPENING`,先做低风险强制重启:

```bash
pm2 stop dada-bot
pm2 restart dada-bot
pm2 logs dada-bot --lines 40
```

如果还是卡住,再在手机端移除这个 linked device,备份 session 后重连:

```bash
pm2 stop dada-bot
mv .wwebjs_auth ".wwebjs_auth.stuck.$(date +%s)"
rm -rf .wwebjs_cache
pm2 restart dada-bot
./ops/relink-qr.sh
```

> 经验:如果 `stop` + `restart` 后过一会恢复 `WhatsApp client ready ✅`,说明是"握手卡死"而不是账号彻底失效。当前代码已有 `UNREACHABLE` 自愈,但 `OPENING` 卡死可能不会触发 `getState()` 抛错;必要时再加外部 watchdog,用 healthchecks.io down 状态自动 `pm2 restart`。

#### 3. `ready` / health up,但报 `failed to list chats` 或 `error handling message: "r"`

这是 WhatsApp Web 刚 linked 后偶发的页面上下文问题:客户端已经 `ready`,healthcheck 也会 up,但 `getChats()` / `getChat()` 访问 chat store 时抛一个很短的 `"r"` 错误。表现是日志里有:

```text
INFO: WhatsApp client ready ✅
ERROR: failed to list chats
ERROR: error handling message
message: "r"
```

处理原则:
- 如果 `.env` 已固定 `WHATSAPP_GROUP_ID`,机器人不需要每条消息都 `getChat()` 才能判断目标群;代码会优先用 `msg.from === WHATSAPP_GROUP_ID` 过滤目标群,避开这类 chat-store 报错。
- `failed to list chats` 只是启动时打印群列表失败,不等于机器人必然 offline。真正判断看目标群发测试消息后是否有六字段确认。
- 若仍不回,先 `git pull origin main && pm2 restart dada-bot`,确认已部署含该修复的版本;再看 `pm2 logs dada-bot --lines 80 --nostream`。

#### 4. `media download failed` / 图片收据不回

如果日志里出现:

```text
WARN: media download failed
message: "r"
```

说明机器人收到了图片消息,但 WhatsApp Web 暂时无法把图片文件下载给 puppeteer。新代码会:
- 对 `downloadMedia()` 重试 3 次。
- 如果图片带 caption 且 caption 像报账格式,即使图片下载失败也会按**纯文字报账**继续确认,避免静默丢单。
- 如果是纯图片且下载失败,会提醒员工重发图片或补一条文字说明。

因此强烈建议员工发票据时**图片配 caption**(至少包含日期、类型、金额、付款人),这样即使 WhatsApp 图片下载偶发失败,账也不会完全卡住。

### 频道 2: 主群静默采集 + 副群审计(推荐先这样上线)

适用场景:机器人已经被拉进真实工作群,但系统还在观察稳定性,暂时不希望机器人在主群说话。此模式不会影响频道 1:测试/副群仍按原流程生成六字段确认,等员工回 `ok` 后才保存。

行为:
- `WHATSAPP_GROUP_ID`:频道 1,互动群/副群。功能保持原样:确认摘要、`ok`、纠错、`cancel`、`/help` 都照旧。
- `MAIN_SILENT_GROUP_ID`:频道 2,真实主群。机器人只监听报账消息,不回复主群。
- `AUDIT_GROUP_ID`:频道 2 的审计群。完整报账会直接写 Notion,然后在这里发 `MM/DD HH:mm Saved to Notion.`
- 婚礼账单如果缺 `WEDDING DATE` 或 `PIC`,不会直接写入 Notion,而是在审计群提示 `Not saved - ... needs WEDDING DATE / PIC.` 这样避免脏数据进账本。
- 图片不需要进 Notion 时,保持 `NOTION_ATTACH_RECEIPTS=false`。
- "正在输入..." 逻辑没有删除:由 `HUMANIZE_REPLIES=true` 控制。它只是 WhatsApp 顶部短暂 presence,不是一条消息;如果 WhatsApp Web 刚 relink 后 `getChatById/getChat` 抛 `"r"`,presence 会自动跳过,但不影响发送正文。
- 风控边界:这不是 WhatsApp 官方 Business API,所以不能承诺 0 风险。频道 2 已把主群风险降到最低:机器人不在主群发言、不发入群自我介绍、不 @ 人、不刷屏;主群只发生一个已加入成员读取消息。若老板要求"绝对不能有任何风险",就不要把机器人拉进主群,继续让员工/管理员把 invoice 转发到 testing 群处理。

VPS 上启用频道 2:

```bash
cd /opt/dada-ledger-bot

# 频道 1: 副群/测试群,保留原互动确认流程
sed -i 's|^WHATSAPP_GROUP_ID=.*|WHATSAPP_GROUP_ID=120363428168476822@g.us|' .env

# 频道 2: 正式主群,只读 + 直接写 Notion
grep -q '^MAIN_SILENT_GROUP_ID=' .env || echo 'MAIN_SILENT_GROUP_ID=' >> .env
grep -q '^AUDIT_GROUP_ID=' .env || echo 'AUDIT_GROUP_ID=' >> .env
grep -q '^MAIN_SILENT_AUTOSAVE=' .env || echo 'MAIN_SILENT_AUTOSAVE=false' >> .env

sed -i 's|^MAIN_SILENT_GROUP_ID=.*|MAIN_SILENT_GROUP_ID=120363284134868849@g.us|' .env
sed -i 's|^AUDIT_GROUP_ID=.*|AUDIT_GROUP_ID=120363428168476822@g.us|' .env
sed -i 's|^MAIN_SILENT_AUTOSAVE=.*|MAIN_SILENT_AUTOSAVE=true|' .env
sed -i 's|^NOTION_ATTACH_RECEIPTS=.*|NOTION_ATTACH_RECEIPTS=false|' .env

git pull origin main
pm2 restart dada-bot
pm2 logs dada-bot --lines 80
```

验收顺序:
1. 在副群发 `15/6 gen 50000 test by putu` -> 应该仍然看到完整确认摘要,回 `ok` 后保存。
2. 在主群发一条完整报账 -> 主群不应出现机器人消息;副群应出现 `MM/DD HH:mm Saved to Notion.`
3. 在主群发一条故意缺 PIC 的婚礼账 -> 主群不应出现机器人消息;副群应提示缺字段,Notion 不应新增脏行。

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
| 运维 | 部署 VPS,7×24 在线(pm2);远程重连两法:**手机号配对码**(`WA_PAIR_NUMBER`)/ **浏览器扫码**(服务器发布 `last-qr.txt` 成网页,电脑打开手机扫,见第七节★) |

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
| 4 | Ling 自付 | `15/6 gen 6.500.000 anggrek supplier bill for ling payment` | 显示 `💰 For Ling to pay: yes` 且 **Handler: LING**;`ok` 后 Notion `For Ling Payment?` 打勾、HANDLER=LING |
| 5 | 打字金额优先 | 转账截图(含手续费)+ 文字金额写含费总额 | **用打字金额**;差额出 ⚠️ `using your typed amount` |
| 6 | 图+文一条发 | 收据照片,caption 写 #1 那行 | ~3 秒快速回,拼成一笔 |
| 7 | 图文分开 | 先发照片,10 秒内再发文字(顺序随意) | 拼成一笔 |
| 8 | 引用照片 | 发照片→隔一会→**引用**它发文字 | 拼进那张照片,不重复记账 |
| 9 | 只发图 | 只发收据照片 | 从图读金额/日期出确认 |
| 10 | 连发多笔 | 一条消息贴 3-15 行 | **一条编号列表**(每行带类型),无 TOTAL |
| 11 | 按行纠错 | 对列表回 `1. 130000` / `3. christi` | 只改那一行,重发摘要 |
| 12 | 补缺 | 缺 PIC 时回 `christi` | 所有缺 PIC 的行补上(已有的不动) |
| 13 | 缺必填拦截 | 婚礼单不写 wed/pic | 显示 `???`;回 `ok` 拒绝保存 |
| 14 | 确认/取消/撤销 | `ok` / `ok all` / `cancel` / `/undo` | `ok`=只存最近一笔;`ok all`=存全部;`cancel`=删最近(引用则删那条,`cancel all` 全删);`/undo` 撤销上一笔并归档 Notion 行 |
| 14b | 引用确认 | 引用某条旧确认回 `ok` | 只保存被引用那一笔 |
| 15 | 报销(截图) | 转账截图 + `reimbursement putri` | 💸 报销确认;金额/日期从截图读;Notion:标题 `REIMBURSEMENT PUTRI`、**PIC=LING、HANDLER=PUTRI**、`EXPENSE TYPE=Reimbursement` |
| 15b | 报销(纯文字) | `14/6 reimbursement to putri 50000` | 同上,金额/日期取自文字(没日期用当天) |
| 15c | 纯数字改金额 | 对着确认回 `1.132.500` | 修正那笔的金额(不是新账) |
| 15d | 引用删单 | 引用发错的原消息、确认摘要、或 30 分钟提醒回 `cancel unsaved expenses` | 只删那一笔待确认 |
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
