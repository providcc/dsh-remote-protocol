# 更新日志

本项目所有值得注意的改动都记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
本项目遵循 [语义化版本](https://semver.org/spec/v2.0.0.html)。

## [未发布]

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
"另一侧怎么处理这个输入"，而不是只看类型。"替违反类型的调用方兜底"删掉了，于是
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

### 变更

- **`1.0.1` 已备好但还没发出去**：版本号已抬到 1.0.1、标签 `v1.0.1` 已推，2026-10-03 第一次
  Release 运行**红在 `Publish to npm`**，日志是
  `Skipped OIDC: ERR_PNPM_AUTH_TOKEN_EXCHANGE … (status code 404)` —— 即 npm 侧那条
  Trusted Publishing 还不存在。注册表上仍然只有 `1.0.0`，**没有半发布**：Publish 是唯一的网络写步骤，
  它一失败就不会往下建 GitHub Release。这正是"从这一步删掉 `NODE_AUTH_TOKEN`"换来的行为——
  以前会静默发一个没 attestation 的版本，现在是响亮地失败。TP 配好后不必重打标签，重跑那次失败作业即可。
- `1.0.1` 这个版本本身**不含代码变更**（上面那批删除在 `[未发布]`，不在它里面），
  它唯一的目的是成为**第一个带 provenance 的发布**。
  `1.0.0` 是用 npm 的 Automation token 发的：pnpm 先试 OIDC，换票拿到 404 后**静默回落**成
  token 发布，于是包发出去了、工作流也绿了，但 `/-/npm/v1/attestations/dsh-remote-wire@1.0.0`
  是 Not found。已发布出去的版本永远补不上 attestation（npm 侧既定行为），所以只能往前发一版。
- 发布凭据改为 **GitHub OIDC / Trusted Publishing**：Release 工作流的 Publish 步骤不再设
  `NODE_AUTH_TOKEN`（token 在场就会掩盖 OIDC 失败），并新增一步 `Verify provenance landed`
  ——发布后 60s 内查不到 attestation 就让工作流红，并直接把配置命令印在报错里。

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

[未发布]: https://github.com/providcc/dsh-remote-protocol/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/providcc/dsh-remote-protocol/releases/tag/v1.0.0
