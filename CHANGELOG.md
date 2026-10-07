# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [2.0.17] - 2026-10-07

> 2.0.16 把规范写成了代码（`SPEC.md` + 六个模块），但**消费方一个都没接**——
> 那六个模块当时只有中继的版本闸与宿主的 `cmdId` 去重在用。这一版是接线，
> 外加两处构造器补齐。
>
> **向后兼容**：全部加性。`encToRelay` / `encBatchToRelay` 加的是**可选参数**，
> 既有三个参数的调用点不受影响；`enc` 帧的 `clientId` 字段在 schema 里本来就存在。

### 变更：`encToRelay` 接受可选的 `clientId`，`seq` 变成可缺省

`clientId` 是协议里唯一一个**两端都不生产、只有中继生产**的字段：端点自己发的
`enc` 不带它（它不知道中继会怎么转发），中继把客户端上行转给主机时才补上
"这是哪台手机"（主机按它做 per-client 回调）。于是中继只能手写
`{t:'enc',…}` 字面量——那意味着 `sessionId` / `seq` / `ciphertext` 三个字段名
在协议层与中继各写一遍，改字段不会有编译错误。

`encBatchToRelay` 的 `items[].seq` 同样改成可选：客户端发来的批量帧本来就可能
不带 seq，而中继在**上行方向不改它**（重新编号是中继→客户端方向独有的）。

⚠️ 批量帧**不带** `clientId` 而单帧带，这不是漏写——`encBatchFrame` 的 schema 里
压根没有这个字段（F 契约），加它要改协议。有判据钉着这条不对称。

### 注释订正

`registry.ts` 与 `classify.ts` 文件头里三处**行号引用已过期**（指向中继改动前的
`server.ts` 位置）。这不是格式问题：照着旧行号去找"手抄的帧名表"会落在别处，
而"找不到"很容易被读成"已经删了"——实际是 2.0.17 才删的。

## [2.0.16] - 2026-10-07

> **为什么是 2.0.16 而不是 2.0.15**：`2.0.15` 已经发出去了，而**那份里没有本次的任何东西**
> （它是 2.0.14 的内容 + 改版本号，由 tag 触发 release workflow 自动发布）。
> 版本号不可重用，所以这一版只能是 2.0.16。
>
> **协议有了规范。** 本版把散在 README / `DESIGN.md` §2 三张冻结表 / 各文件头注里的
> 契约，收成一份 [SPEC.md](./SPEC.md)（`dsh-rc/1`，RFC 2119 措辞），
> 并把其中六类此前只以注释存在的规则变成可执行的代码。
>
> **向后兼容**：全部是**加性**的——新增可选字段、新增导出，没有一个既有字段被改名或删除。
> `capabilities` / `retryAfterMs` / `unsupported_protocol` 缺省即不出现，
> 老对端 strip 掉它们，行为与 2.0.14 完全一致。

### 新增：`SPEC.md`（规范性文档）

四层契约（传输 / 控制面 / 密码学 / 数据面）、版本与能力协商、交付语义
（顺序 / 幂等 / 重放 / 离线补拉 / nonce 唯一性）、错误模型、能力与限额上报、
演进与兼容策略、注册表，外加三份附录（冻结字节级 B1–B9 / 帧 F1–F13 / 传输 T1–T8）。

附录 D 是「规范里有、代码里还没有」的**有序**待办——把它单列而不是散在正文里，
是因为「规范说了但没做」和「做了但规范没说」必须都能被看见。

### 新增：六个模块（规范的可执行部分）

| 模块 | 替掉了什么 |
|---|---|
| `limits` | 三个仓里各写一遍的附件上限 / 帧预算 |
| `registry` | 中继手抄的帧名清单、伞仓正则抽源码字面量的做法 |
| `classify` | 中继 `src/server.ts` 里隐式的七步分流 |
| `errors` | 「这个错误码该怎么办」在三个消费方各自的推断 |
| `negotiate` | `hello.protocol` 传了但没人校验 |
| `idempotency` | `cmdId` 不去重（超时重发 = 命令执行两次） |

`classify` 的价值在两处细节：**第 5 步（帧名在不在）与第 6 步（形状对不对）必须分开**，
以及**两条配对特例要早于 schema 判定**（`pair-begin-client` 形状坏要回
`pair-fail`，因为小程序只认那四个 reason 的中文映射）。

`registry` 用编译期断言守住「表与 zod 判别联合逐项相等」——
写这条断言的当天它就抓到了一次真漂移：`relayFrame` 联合里有 `enc` / `enc-batch`
（它们两个方向都有），而人抄的那张表只有 8 个控制帧名。

### 变更（加性）

- `hello` / `hello-ok` 新增可选 `capabilities: string[]`（长度有上界：`hello` 在认证之前就能收到）。
- `error` 新增可选 `retryAfterMs`（毫秒）。借鉴 RFC 9110 的 `Retry-After` 的毫秒形态；
  只有 `rate_limited` / `pair_table_full` 这类「等一等就好」的码才该带它。
- 错误码新增 `unsupported_protocol`：它是**版本问题**而不是形状问题，
  唯一该触发的动作是「把版本说清楚」。加它不破坏任何老实现（老 client 走兜底展示），
  但中继 MUST 同时带一句中文 message。
- `frames` 仍然转出 `MAX_RELAY_MESSAGE_BYTES` / `MAX_CIPHERTEXT_BYTES`
  （中继从 `dsh-remote-wire/frames` 引它们；撤掉是一条只会在下游编译期爆炸的变更）。

### 新增：`endpoint → relay` 的出站构造器

`outbound` 此前只有「中继 → 端点」与「host → client 载荷」两段，
于是**中继唯一会解析的那一组帧**全靠调用方手写字面量——
而宿主插件正是这么用的（七个帧），只有入站帧过 schema。
补上 `helloForHost` / `helloForClient` / `pairBegin` / `pairClaim` / `ping` /
`encToRelay` / `encBatchToRelay` / `sessionLeave` / `resync`，
返回类型是 `EndpointFrame` 判别联合——参数表上不存在的字段**在类型上就写不出来**。

### 判据

107 → **152** 条。15 次变异全部变红；其中两条改写成**能编译**的形状重跑过一次
（「变异要能编译，否则测的是上一个产物」）。

## [1.0.0-rc.1] - 2026-10-06

> **首个开源候选版。** 四仓（wire / 宿主插件 / 中继 / 小程序）从今天起**统一用这一个版本号**；
> 在它之前的 1.9.0 / 2.0.x / 1.0.6 / 1.1.x 是私有期的编号，不再作为发版口径。

### 修复（本轮逐行审计的产出）

- **密文上限跟着中继预算走**（`MAX_CIPHERTEXT_BYTES` = 中继 1 MiB 预算 − 8 KiB 余量）。
  原来写死 512 KiB，而手机侧附件闸门是 512 KiB **原始字节**——base64 胀 4/3 再套
  secretbox 封装，一条合法的四图消息密文约 930 KiB，**被自家 schema 先拒掉**，
  用户看到的是"图片/文件发不出去"。
- **`keepDisplay` 的 caffeinate 参数原来是坏的**：`-u` 不接参数，`disk,display` 被当成
  要 exec 的 utility，而 man page 明写 `-w` 在有 utility 时被忽略——恰好丢掉了
  "断言寿命绑到宿主 pid"，崩掉的宿主会留下一台永远不睡的机器。
- `enc-batch` 项数上限 200；`hello.clientMeta` / `token` 长度上限（未认证的日志放大通路）。
- KDF 入口校验 PSK 形状（宽容 base64 解码在 KDF 路径没有 Poly1305 兜底，一把被改坏的
  psk 会静默派生出错钥）；nonce 计数器上界（越界静默截断 = nonce 复用）。
- `formatPairingToken(NaN)` 抛错而不是产出 `000NaN`。
- `isoOrUndefined` 归一化 + 超大数不再抛（它本是"最后一道防线"）；`isoText` 真的校验时间。
- 空的提问 / 空的作答拒收（它们都是"看着像答案、其实什么都没答"的形状）。
- 出站构造器守自己 schema 的约束（`pairReady` 的 ttlMs、`enc` 的密文长度、批量非空）。
- 配对 URI 解析收紧三条（path 必须是 `/p`、地址必须 ws(s)、psk 必须像 base64），
  与小程序侧逐字同步——33 组向量对拍锁住这件事。

判据：93 → **106** 条（新增的都在旧代码上验过会红）。

## [1.9.0] - 2026-10-06

### 新增：`cmd.get_pending`——手机主动拉还挂着的审批/提问

审批/提问卡是"一次性"的一帧：手机退后台、断线、停在列表页时错过就没了。
`peer-joined` 的重发（control 2.0.12）只发生在重配对；普通 socket 重连中继不通知
主机，主机收不到任何信号。于是手机在（重）连上、进会话页时主动拉一次：
主机把 `pending` 里还挂着的按原请求帧重发（同一 `requestId`），没有只回
`ev.result{ok:true}`。`sessionId` 可选（带了只重发那条会话的）。

向后兼容：老主机不认这条命令（schema 丢弃），手机 fire-and-forget，不做 waiter、
不弹错——先发 wire，再发 control，顺序不能反。

## [1.8.1] - 2026-10-06

### 新增：`ev.retry` 与 `ev.compaction`——重试 / 压缩中的回合不再看起来像死掉

真机取证：最近十几份会话日志里 `llm/retry` 与 `compaction/end` 各出现 18 次，
而插件两条都不映射——主机明明在重试 / 压缩，手机上却是一片空白，
用户读成"挂了"就手工打断。

- **`ev.retry {sessionId, attempt, max, reason?}`**：第几次 / 共几次 / 什么原因，
拼出"retrying 2/5: TRANSPORT"够用的三件。`reason` 取的是 `failure.code` 而不是
`failure.message`（"Connection error." 对人不说明任何事），可空（宿主偶尔不带）；
`policyKey` 那坨策略 JSON 留在主机，不出站。
- **`ev.compaction {sessionId, state: started|ended|failed, error?}`**：
`failed` 与 `ended` 是两件事（真机见过 `summarization produced no text summary content`），
合并会让用户在上下文已经烂掉时以为一切正常。

出站构造器 `retryNotice()` / `compactionNotice()`。`workspace/changes`
**故意不映射**：66 个样本全只带 `{turn}`，文件清单在中继够不着的鉴权路由后面——
"文件变了但说不出是哪些"比不说更糟。

### 破坏性变更：排队那一整套删除（`c5ffb30 feat!`）

`queueId`（`cmd.send_prompt` 的可选字段）、`cmd.drop_queued`、`cmd.get_queue`、
`ev.queue`（含 `QueueItem`）、出站 `queueSnapshot()` 全部删除。
1.7.0 / 1.8.0 建的、1.8.1 拆的——同一天里的一建一拆：
主机侧（`dsh-remote-control` 2.0.9，`011450e`）把 `PromptQueue` 一起删了，
`send_prompt` 改为直发并如实报失败。手机侧不要再发这三个命令、
不要再读 `ev.queue`；需要"排队可见"请等新的方案，不要按 1.7.0 / 1.8.0 的形状自己拼。

### 变更（调用方注意）：`ev.model` 的 `sessionId` 改为必填（`0badb4b`）

模型是**按会话**的：以前这个字段根本不存在，手机只能当全局值显示——
2026-10-05 用户实测，本会话跑 `space-bunny-free`，
顶栏却显示别的会话切出来的 `muse-spark`。
现在发送侧 `outbound.model()` 要求 `sessionId`，schema 侧缺了就整帧拒收：
老主机发来的全局帧手机**宁可丢掉也不显示错的**。
升级时主机与小程序要一起走，只升一头会出现"模型顶栏短暂空白"
（新手机等带 `sessionId` 的帧）或"顶栏仍可能串台"（老手机）。

### 修复：`peer-left` 带 `unpaired`（`e5eeb83`）

中继发给主机的 `peer-left` 有两个长得一模一样的触发：手机点"解除配对"
（此后这个 convId 永远不会回来，主机留着就是幽灵会话）与手机 socket 断线
（D3 要求会话留着，回前台还要用）。`unpaired: true` = 前者，
主机把会话一并作废，pill 从"手机离线"回到"未配对"；
字段可选，老中继不带就按断线处理。

## [1.8.0] - 2026-10-05

### 新增：`cmd.get_queue`——进会话时主动把排队快照拉回来

`ev.queue` 只在状态变化时被动推：手机进一个会话、从后台切回前台、刚重连时，
主机这边什么变化都没发生，于是没有任何一帧会来，手机上就是空的——
2026-10-05 用户实测，进会话看不到当前的排队消息。
纯推送在没有触发点时必然失效，所以补一条主动拉取：
手机每次进会话 / 回前台发 `cmd.get_queue {cmdId, sessionId}`，主机立刻回当前全量
（"以 dsh 为准"：主机是唯一真相源，进来时问它要）。

（注：tag `v1.8.0` 落在下一跳 `f94f490 style: prettier` 上，内容就是这一条；
排队整套在 1.8.1 已随主机队列一起删除，见上。）

## [1.7.0] - 2026-10-05

### 新增：排队双向同步（`queueId` + `cmd.drop_queued` + `ev.queue` 全量快照）

2026-10-05 用户：排队要双向同步、手机要能删。

- `cmd.send_prompt` 多一个可选 `queueId`（手机自己编号，不透明字符串，最长 64，
主机原样存、原样回、原样拿来删；老手机不带就还是老行为）；
- `cmd.drop_queued {cmdId, sessionId, queueId}` 删一条还没转发的消息——
**只能删 `held`**：转发出去的进了 agent 的 inbox，宿主没给删除入口，
那时回 `ok: false` 并说清"已经在跑了"，不给假成功；
- `ev.queue {sessionId, items: QueueItem[≤64]}` 全量快照，
`QueueItem = {queueId, text, images?, files?, state: held|sent|failed, message?}`，
队列每次变化（入队 / 转发 / 失败 / 删除 / 切会话）都推一次；
手机不许在本地增删这张表，它是主机状态的镜子。

⚠️ **这一版立了 tag `v1.7.0`，但从未发到 npm**（注册表里没有 1.7.0）：
要排队能力的直接用 1.8.0；且整套在 1.8.1 已删除（见上），新代码不要再依赖这些名字。

## [1.6.0] - 2026-10-05

### 新增：`cmd.send_prompt` 可带文件附件（`files`，最多 4 个）

用户一句话："文件附件也支持一下"。
`fileAttachment = {name, mediaType?, data(base64)}`，
`files` 与 `images` 并列、可选、上限都是 4。
与图片的三处不同，都是文件这件事本身逼出来的：

1. **没有 mediaType 白名单**——图片能收 `image/jpeg` 字面量是因为相册出来
必能重编码成 jpeg，文件各有各的格式，主机只记录类型、不解析内容；
2. **没有魔数校验**——图片有 JPEG 魔数，文件的"魔数"族类太多，
纪律全落在两侧的条数与体积闸上；
3. **文件名就是落盘名**（图片会被强改成 `.jpg`）——Agent 认文件靠扩展名，
收敛仍走 `safeSegment`（手机传来的名字是不可信输入）。

与图片共用同一条体积预算（`MAX_ATTACH_TOTAL_BYTES`）：中继单帧 1MB 是硬上限，
超了不是"发不出去"而是整帧被掐、socket 1009 断开——超预算挡下并说清，不悄悄砍内容。
向后兼容：可选字段，未知键 `zod strip`，老手机照旧发得出去。

## [1.5.0] - 2026-10-05

### 新增：历史页可以带待办快照（`ev.todo` 进 `historyItem` 联合）

`ev.session_history.items` 从两种叶子载荷扩到三种：`ev.todo` 现在也能出现在历史页里。
待办是全量快照，一页里**最后一条**就是那一页截止时的清单——回放它，进一条跑过的
会话也立刻看得见待办，不用等下一次 `todo/write`（这是 1.4.0 上线时留下的 v1 边界）。

向后兼容：老手机回放到不认识的 `t` 会静默跳过（分发是一串 if），所以这一跳
可以先于小程序那半上线。宿主侧回放规则：只在**第一页**（最新一页）应用，
更早页的待办是过期快照；已经在流的实时帧优先（后到者胜）。
## [1.4.0] - 2026-10-05

### 新增：`ev.todo` —— 待办清单全量快照帧

手机聊天页顶部那颗待办条的数据源。内核 `todo/write` 每次整份下发
（`TodoItem = {content, status: pending|in_progress|completed}`），协议原样收成快照：
手机不做增量，也不需要理解"改了哪条"。

三条约定：`status` 只认内核那三个值（未知值由宿主侧降级，协议层不放行）；
`content` 不限形状只限长度（宿主侧夹 200 字）；**空数组是合法载荷**——
内核清空清单时手机必须跟着清。出站构造器 `todoList({todos, sessionId?})`。

向后兼容：老手机收到不认识的 `t` 静默忽略，所以这一帧可以先于小程序上线。
## [1.3.0] - 2026-10-04

### 新增：`cmd.send_prompt` 可以带图片附件

手机发消息时最多带 **4 张 jpeg**（`images: [{name, mediaType:'image/jpeg', data(<base64>), width?, height?}]`）。
字段是**可选增补**：不带 `images` 的老手机照旧发得出去，带了的消息发到老主机那边，
主机只读 `text`（zod strip 未知键）——所以这是向后兼容的一跳，不升协议版本，
上线顺序也没有约束。

两条纪律写进 schema 而不是文档：
1. **只收 jpeg**。相册选完由 mp 的 `wx.compressImage` 统一输出，png 之类在协议层就挡下
   ——放到应用层就会出现"主机存了一堆主机读不了的类型"。
2. **上限 4 张**。中继 `DRC_MAX_MSG_BYTES` 是硬上限（server 仓 1.0.3 起默认 1MB），
   超了整条帧被掐；4 张是"看清楚这几张"与"别把帧撑爆"的折中。

为什么图片走 base64 而不是路径：图片在**手机上**，主机那头没有这个文件；
而整条载荷是 JSON（之后还要 seal 成密文帧），二进制在 JSON 里只有 base64 一条路。
体积的事因此全在 mp 侧的压缩参数上（压缩率见 mp 的 `IMAGE_QUALITY`）。

## [1.2.0] - 2026-10-04

### 新增：两条"收回卡片"的载荷与提问卡的到期时刻

主机现在**同时**问桌面与手机（谁先给出真实决定谁算——插件不许改变宿主自己的行为，
抢答会让 DSH 自己那个审批窗不弹）。两端同弹之后，"输的那一侧的卡怎么收"就成了协议问题，
而不是界面细节：留着不动的话，手机上那张卡还在倒计时、按钮还能点，
点下去是对着一个**已经关闭的请求**做写操作。

- **`ev.permission_resolved {requestId, sessionId?, by?}`**——收回一张不必再答的审批卡。
- **`ev.question_resolved {requestId, sessionId?, by?}`**——同一形状，收提问卡。
  `by` 只有 `'desktop' | 'cancelled'` 两个取值，它说的是"谁收的场"，**不是答案**：
  放开取值，手机端就得替主机维护一张语义表，而这张表迟早与主机分叉。
  按 `requestId` 对号，所以一次答完不会误收别的会话或别的请求那张卡。
- **`ev.question_request` 补 `expiresAt`（可选，ISO 字符串）**——审批那条本来就有，
  提问这条一直没有：主机侧 `questionTimeoutMs`（默认 300 秒）到点就判"没答上"，
  而手机上看不见任何倒计时，用户不知道自己按的按钮什么时候作废。
  这条补的是"超时必须可见"，不是新功能。

**上线顺序可以是协议 → 主机 → 小程序**：老版本的小程序遇到不认识的 `t` 会静默忽略
（那条分发是一串 `if (p.t === …)`），`expiresAt` 同理是多一个键而已，所以先发不炸任何人。
粗收单的那条路（`ev.run_state` 一帧把这一会话挂着的审批与提问**全**收掉）继续保留，
主机两侧同时发：精确帧负责"只收这一张"，`run_state` 负责兼容现在装在手机上的那一版。

### 修复

- **`tsconfig.json` 补上 `"types": ["node"]`，解 TypeScript 7 的编译不通过**。
  TS7 不再把 `@types/node` 自动纳进来，于是本仓在 `typescript@7.0.2` 下报 **40 个错**
  （`Cannot find name 'node:crypto'` / `'TextEncoder'` / `'Buffer'` / `'URLSearchParams'`…，
  另有几条 `possibly 'null'` 是这些类型缺失的下游）。这一行加完 **0 个错**，
  而本仓自己的 TypeScript 5.9 行为不变（`pnpm typecheck` 与 82 项测试都照旧绿）。
  动机是 Dependabot 那个 `chore(deps): bump typescript from 5.9.3 to 7.0.2` 一直红着；
  它红在装依赖之前（`ERR_PNPM_BAD_PM_VERSION`，PR 分支基线陈旧），所以这条修复**在 CI 上
  要等分支更新到最新 main 之后才看得见**。

## [1.1.0] - 2026-10-03

### 新增：`ev.model`（当前模型）

小程序顶栏要显示"现在跑的是哪个模型"，于是加了一条载荷 `ev.model`：
`{ t, model, provider?, canSwitch, options?, reason? }`。

**为什么 `canSwitch` 必须由生产侧显式给出**，而不是让手机看 `options` 有没有值来推断：
「内核不能换」与「能换但这里没列全」在手机上必须表现不同（置灰并说明原因 vs 可点的列表）。
推断出来的判断在"清单刚好为空"时会静默错成不可切，而"点了没反应"是最难排查的现象。
配套的 `outbound.model()` 在 `canSwitch` 为假时**主动把候选吃掉**（不下发 `options` 键），
因为空数组会让"有候选但都不可选"和"根本没有候选"在手机上一回事。

这一代内核（`agentDefaultModel` 上只有 `currentSelection`）只能读，线上实测
`modelFace = no-list+no-set`，所以 `canSwitch` 恒为 `false`。字段先立好，
等内核补上写能力，只改宿主那一侧。

### 删除（零调用的导出与投机防御）

按"没用的就删，用到再重写"过了一遍三个消费者（中继、宿主插件、小程序对拍）之后：

- 零调用导出：`DEFAULT_RELAY_PORT`、`looksLikeConversationId`、`isEncFrame`、
  `parseEndpointFrameText`、`makeEncFrame`、`makeEncBatchFrame`、`frames.ts` 里那份与
  `outbound.makeError` 重复的 `makeErrorFrame`、`outbound.peerJoinedNotice`、
  `OutboundPayload`。README 从未列过这些名字，`e2e/protocol.test.mjs` 的 18 条对拍全绿。
- `pair-begin` 的可选字段 `hostLabel`：唯一生产者（宿主插件 `relay.ts`）从不发它，
  中继也不读；小程序那个 `hostLabel` 来自配对 URI，不是这条帧。
- `outbound.pairFail` 的 `reason` 联合里删掉 `'rate_limited'`：线上枚举（`pairFailFrame`）
  从来只有四个值，小程序的 `translatePairFail` 也只有一个四键的中文表——留着它等于允许
  写出一行**必然过不了自家 schema** 的调用。
- `isoOrUndefined` 里 `Number.isNaN(Date.parse(iso))` 那条死分支：`iso` 是上一行
  `new Date(ms).toISOString()` 刚产出的，永远可被 `Date.parse` 认出来。

**一处删错了，被对拍闸门当场抓住**：`normalizePairingToken` 与 `parsePairingUri` 开头那两处
`String(x ?? '')` 被我当成"替违反类型的调用方兜底"删掉了，于是
`e2e/protocol.test.mjs` 的"fixtures：配对码归一化两侧相同"立刻红在
`Cannot read properties of undefined (reading 'replace')` —— 那条 fixture **故意**喂 `undefined`
（`v.input === null ? undefined : v.input`），要的是两侧同返回 `''`；而小程序侧
`codec.js:parsePairingQr` 写的就是 `String(text || '')`，本函数的契约也明写着"任何不合法输入
返回 null"。两处已原样恢复。**记下来**：跨实现比对里的"防御"常常是契约的一条腿，删它之前要先问
"另一侧怎么处理这个输入"，而不是只看类型。

**版本判断**：这些删除**没有记进 `1.0.1`**——那一版唯一的目的是成为第一个带 provenance 的
发布，标签已经推出去了。按语义化版本，移除公共导出该走 major；但本包在生态里的消费者就是
本仓那三个（都是 `^1.0.0`），且被删的名字从未出现在 README 的模块清单里，所以这里按
`1.1.0` 记，并在正文里写明"外部若依赖这些名字请锁 `1.0.0`"。要改成 `2.0.0` 就得同时抬
两个消费仓的依赖范围。

## [1.0.1] - 2026-10-03

### 变更

- **这一版不含代码变更**：它唯一的目的是成为**第一个带 provenance 的发布**。
  `1.0.0` 是用 npm 的 Automation token 发的——pnpm 先试 OIDC，换票拿到 404 后**静默回落**成
  token 发布，于是包发出去了、工作流也绿了，但 `/-/npm/v1/attestations/dsh-remote-wire@1.0.0`
  是 Not found。已发布出去的版本永远补不上 attestation（npm 侧既定行为），所以只能往前发一版。
- 发布凭据改为 **GitHub OIDC / Trusted Publishing**，并新增一步 `Verify provenance landed`
  独立体检。**`1.0.1` 现在是带 attestation 的**：
  `curl https://registry.npmjs.org/-/npm/v1/attestations/dsh-remote-wire@1.0.1` 回的是真证书。
- ⚠️ **第一次 Release 运行"红"是假红，别照着它重发**：`Publish to npm` 步骤**成功**了，
  红的是自检那一步——窗口只有 60s（20×3s），attestation 落地比它慢。后果不是包没发出去，
  而是排在它后面的 `Create GitHub Release` 被 skip，于是"有包没公告"。
  修法两条都已落进工作流：窗口抬到 200s，`Publish` 步骤改成**版本号已在注册表就跳过**
  （版本号一旦发出就永远不可复用，重跑只会撞 403）。
  同一次排查还纠正了一条写进注释的事实：`NODE_AUTH_TOKEN` 从来不是"没设"——
  `actions/setup-node` 收到 `registry-url` 就会把它的 `token` 输入（默认 = `github.token`）
  写进去。现在 Publish 步骤把它**显式清空**，"没有 token 这条路"才成为一个赋值而不是一句希望。

## [1.0.0] - 2026-10-03

### 新增

- DSH Remote Control 线协议的首次公开发布。
- 基于 `tweetnacl` 的 XSalsa20-Poly1305 密封记录加密（`seal` / `open`）。
- PSK 生成与 `c2h` / `h2c` 两把方向密钥的派生，并支持在无 CSPRNG 的运行时上用计数器 nonce。
- 中继控制帧与 `cmd.*` / `ev.*` 载荷目录的 zod schema 与解析器。
- 中继 → 端点、主机 → 客户端消息的类型化出站构造器。
- `dshr:/p?...` 配对 URI 编解码与 6 位码工具。
- 会话 / 主机 / 命令 id 生成。
- 跨平台防休眠命令构造器（`caffeinate`、`systemd-inhibit`）。

[未发布]: https://github.com/providcc/dsh-remote-protocol/compare/v1.8.1...HEAD
[1.8.1]: https://github.com/providcc/dsh-remote-protocol/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/providcc/dsh-remote-protocol/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/providcc/dsh-remote-protocol/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/providcc/dsh-remote-protocol/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/providcc/dsh-remote-protocol/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/providcc/dsh-remote-protocol/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/providcc/dsh-remote-protocol/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/providcc/dsh-remote-protocol/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.1.0
[1.0.1]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.0.1
[1.0.0]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.0.0
