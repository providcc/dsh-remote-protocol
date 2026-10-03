# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

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
