# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

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

[未发布]: https://github.com/providcc/dsh-remote-protocol/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.1.0
[1.0.1]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.0.1
[1.0.0]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.0.0
