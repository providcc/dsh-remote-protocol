# SPEC — DSH Remote Control 线协议规范

> **协议标识**：`dsh-rc/1`（线协议版本 `PROTOCOL_VERSION = 1`）
> **规范版本**：1.0.0（2026-10-07）
> **状态**：规范性文档（normative）。协议层实现仓库 [`dsh-remote-protocol`](https://github.com/providcc/dsh-remote-protocol)，npm 包 [`dsh-remote-wire`](https://www.npmjs.com/package/dsh-remote-wire)。

## 0. 这份文档是什么

### 0.1 是什么

一份**规范性**文档：它定义 DSH Remote Control 的传输、控制面、密码学与数据面四层契约，
用 [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) 的 MUST / MUST NOT / SHOULD / MAY 措辞写出义务，
并规定每一类实体的**一致性要求**（§16）。

规范与代码的关系是双向锁定的：

- 规范里每一条 MUST，MUST 至少有一条机械判据（`node --test`），否则它只是愿望；
- 代码里每一条分支，规范里 MUST 有一句话说明它为什么长这样。

### 0.2 不是什么

- **不是实现指南**。怎么起进程、怎么装 profile、怎么部署 nginx，见
  [`../dsh-remote-server/docs/SELF-HOSTING.md`](https://github.com/providcc/dsh-remote-server) 与伞仓
  [`docs/HOST-SIDE.md`](https://github.com/providcc/dsh-remote-control)。
- **不是安全评估**。威胁模型与取证在伞仓 `docs/SECURITY.md`；本文 §14 只写**协议层**必须满足的安全义务。
- **不是现状描述**。凡是"现在是这样"的，一律带 `file:line`；凡是"应该是"的，一律写成 MUST。
  两者不一致的条目集中在**附录 D**，那里是有序的待办，不是免责声明。

### 0.3 与其它文档的关系

| 文档                               | 定位                                 | 与本文的关系                                  |
| ---------------------------------- | ------------------------------------ | --------------------------------------------- |
| 本文 `dsh-remote-protocol/SPEC.md` | **规范**（normative）                | ——                                            |
| [`README.md`](./README.md)         | 包的使用说明                         | 引用本文的术语与契约编号                      |
| [`SECURITY.md`](./SECURITY.md)     | 本包的安全边界                       | §14 的展开                                    |
| [`CHANGELOG.md`](./CHANGELOG.md)   | 变更史                               | 附录 F 的来源                                 |
| 伞仓 `docs/DESIGN.md` §2           | 重写时的**冻结契约表**（B/F/T 三族） | 附录 A/B/C 逐条收录，并给出它与本文的对应关系 |
| 伞仓 `docs/HANDOFF.md`             | 排错第一入口                         | 不是规范                                      |

> **关于附录 A/B/C 的编号**：`DESIGN.md` 里的 `B4`、`F1`、`T2` 是本项目的历史编号，
> 本文按原样保留，理由是那些锚点已被三仓代码与判据引用了几百处；改编号的收益是零，
> 代价是所有 `file:line` 注释失效。

---

## 1. 角色、拓扑与术语

### 1.1 三个角色

| 角色                 | 谁扮演                        | 代码位置             | 信任级别                                             |
| -------------------- | ----------------------------- | -------------------- | ---------------------------------------------------- |
| **host（受控端）**   | 跑在用户机器上的 DSH 宿主插件 | `dsh-remote-control` | 持有 PSK 与宿主权限，**唯一可信的真相源**            |
| **relay（中继）**    | 第三方自建/托管的转发节点     | `dsh-remote-server`  | **零知识**：结构上不得接触载荷明文与密钥             |
| **client（客户端）** | 微信小程序                    | `dsh-remote-mp`      | 持有 PSK（来自二维码），可信度由配对时的物理接触建立 |

一个 relay 服务**多个互不关联**的 host / client 对（`docs/EXPANSION-PLAN.md` §1 前提 1）。
relay MUST NOT 让两个 host 实例共享任何状态；convId 与 hostId 是两套命名空间。

### 1.2 拓扑

```
   client (小程序)                                        host (插件)
        │  wss://relay/…                                        ▲
        │  ① hello{role:'client', protocol, capabilities}      │
        ├──────────────►  relay  ──────────►  host              │
        │  ② hello-ok{clientId, protocol, capabilities}        │
        │  ③ pair-begin-client{pairingToken}                   │
        │  ④ paired{sessionId, hostId}  ← 双方据此派生方向密钥  │
        │                                                       │
        │◄═ ⑤ enc{sessionId, seq, ciphertext}（密封载荷）═════►│
        └───────────────────────────────────────────────────────┘
                        relay 只看 t / sessionId / seq，
                        ciphertext 对它是不透明字符串
```

### 1.3 术语

| 术语                      | 含义                                       | 与代码的对应                                    |
| ------------------------- | ------------------------------------------ | ----------------------------------------------- |
| **conversation / convId** | 一次配对建立的长期通道，`c_` + 12 hex      | `newConversationId()`，`CONVERSATION_ID_PREFIX` |
| **hostId**                | 一台受控端的稳定身份，8 位 hex             | `newHostId()`                                   |
| **clientId**              | 一次安装的身份，**弱随机、非秘密**         | 小程序生成，relay 权威化（`hello-ok.clientId`） |
| **installId**             | 小程序侧安装 id，**只参与 nonce 前缀派生** | `session-store.js` 的 `drc.installId`           |
| **PSK**                   | 16 字节配对共享密钥，每次配对轮换          | `generatePsk()`                                 |
| **cmdId**                 | 一次命令的相关 id，回执靠它对答            | `newCmdId()`（UUID）                            |
| **两个 sessionId**        | 见 §1.4 —— 本协议最贵的一类混淆            | ——                                              |

### 1.4 两个 `sessionId`（契约 B 侧 / F3）

| 位置                         | 语义            | 取值                                           |
| ---------------------------- | --------------- | ---------------------------------------------- |
| **控制帧外层** `sessionId`   | **配对通道 id** | `c_xxxx`，= convId，路由凭证                   |
| **数据面载荷里** `sessionId` | **DSH 会话 id** | 与 `ev.session_changed.sessions[].id` 同名同值 |

混淆它 = 聊天页把所有事件过滤掉，**没有任何一层报错**。
每个实现 MUST NOT 用错；规范上它们是两个不同的字段名空间，不允许在实现里共用一个变量。

---

## 2. 协议分层与业界参考

### 2.1 四层

| 层            | 承载                                 | 本规范章节   | 失败的表现         |
| ------------- | ------------------------------------ | ------------ | ------------------ |
| **L4 传输**   | WebSocket over TLS                   | §4           | 连接断开/关闭码    |
| **L3 控制面** | 明文 JSON 帧，relay 唯一读得懂的东西 | §5、§8、§12  | 配对失败、路由失败 |
| **L2 密码学** | 密封记录 + 方向密钥                  | §7           | `open()` 返回 null |
| **L1 载荷**   | `cmd.*` / `ev.*`                     | §9、§10、§13 | 载荷被静默丢弃     |

四层**各自独立失败**，且失败的可观测性也不同——这个分层本身是照着
[LSP 的 Base Protocol 分层](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
（transport / base protocol / language features）抄的形状。

### 2.2 借鉴表：借了什么、为什么、与本规范的差异

> 这一节是本文档存在的理由之一。协议设计的绝大多数"看起来显然"的选择在别处都已经付过学费，
> 把出处写出来，是为了让下一个人不必重新发明，也便于在设计变更时知道自己在动哪条行业惯例。

| 业界来源                                                                                                   | 借鉴内容                                                                                       | 本协议的落地                                                          | **刻意不照搬的部分**                                                                                        |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [RFC 6455 WebSocket](https://www.rfc-editor.org/rfc/rfc6455)                                               | 文本帧语义、关闭码语义（1001/1008/1009/1013）、扩展关闭码（4000–4999 私有段）                  | §4.2；relay 的 `4000/4001/4008` 落在 RFC 6455 §7.4.2 保留段           | RFC 6455 的 1006/1011 我们**不使用**：对端无法据此行动，暴露出来只是让人困惑                                |
| [RFC 2119 / 8174](https://www.rfc-editor.org/rfc/rfc2119)                                                  | MUST / SHOULD / MAY 措辞与大小写敏感性                                                         | 全文                                                                  | ——                                                                                                          |
| [RFC 8259 JSON](https://www.rfc-editor.org/rfc/rfc8259)                                                    | 帧即一个 JSON 值；对象成员无序；解析失败即失败                                                 | §4.3                                                                  | JSON 允许重复键而我们**拒绝**（§4.3.2），因为重复键的分歧表现是"两边算出了不同的消息"                       |
| [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)                                         | 结构化错误（type/title/status/detail）、**机器可判 + 人可读并存**                              | §12：错误帧带 `code`（机器）+ `message`（人）+ `retryAfterMs`（策略） | RFC 9457 的 `type` 是 URI 且带 `status`，WS 帧里没有 HTTP 状态码，我们用 `code` 枚举代替                    |
| [RFC 9110 §10.2.3 Retry-After](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after)                   | 限流要告诉对端**多久之后**再来                                                                 | §12.3 `error.retryAfterMs`                                            | 我们只发毫秒数不发 HTTP-date：两端都没有可信时钟（§4.5）                                                    |
| [JSON-RPC 2.0](https://www.jsonrpc.org/specification)                                                      | 请求/响应配对（`cmdId` ↔ `ev.result`）、`id` 必须原样回传、实现定义错误码区间                  | §9.2、§12                                                             | JSON-RPC 的 in-band `error` 对象我们**不照抄**：数据面载荷整体密封，外层错误帧是 relay 的控制面，两者不能混 |
| [Signal: X3DH + Double Ratchet](https://signal.org/docs/specifications/x3dh/)                              | 方向密钥分离、消息密钥每条推进（棘轮）、密钥轮换时的会话恢复                                   | §7.4（v1 已落地：方向密钥分离）、§7.6（v2 路线图）                    | v1 **没有**棘轮：微信小程序无 CSPRNG 假设，见 §7.5 的诚实说明                                               |
| [RFC 5869 HKDF](https://www.rfc-editor.org/rfc/rfc5869)                                                    | 从共享秘密导出多把子密钥的标准做法                                                             | §7.3 记录"为什么 v1 没用它"                                           | v1 的 KDF 是 SHA-512 拼接式；升级路径见 §7.3.1                                                              |
| [RFC 4648 §4 base64](https://www.rfc-editor.org/rfc/rfc4648#section-4)                                     | 标准字母表 + padding；解码侧的宽容口径                                                         | §7.2、契约 B2                                                         | ——                                                                                                          |
| [RFC 7595 URI Scheme 注册](https://www.rfc-editor.org/rfc/rfc7595)                                         | 自定义 scheme 的注册要求（scheme 名不得含 `+`，且应说明是否可多级解析）                        | §6.1 `dshr:` scheme                                                   | 我们**没有**正式注册，只在文档里固定语法——见 §6.1.4 的诚实边界                                              |
| [CloudEvents 1.0](https://cloudevents.io/)                                                                 | 事件信封的必备维度（id / source / type / time）、扩展属性命名                                  | §9.1 的 `ev.*` 目录借用 `t` 作为 type、`sessionId` 作为 source        | CloudEvents 的 `data` 与 `time` **不引入**：时间戳必须由接收端本地生成（无可信时钟，§4.5）                  |
| [Matrix Client-Server](https://spec.matrix.org/latest/client-server-api/)                                  | 游标分页（`next_batch` 语义）、"没有游标 = 到底"的表达方式、历史回放与实时流共用同一套事件形状 | §10.4（`ev.session_history.nextBeforeSeq`）、§9.3                     | Matrix 的 `since` 增量同步我们不实现：我们的真相源是"全量快照 + 事件"（§10.4）                              |
| [VS Code LSP](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) | `$/progress`、`$/cancelRequest`、`textDocument/didOpen` 的**状态式**与**增量式**分离           | §10.2（`cmd.interrupt` 是一等公民）、§9.3（历史复用实时载荷形状）     | LSP 的 `Content-Length` 分帧：WS 自带消息边界，我们不重复发明                                               |
| [MQTT 5.0](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)                                      | QoS 等级、`retain`、遗嘱消息（LWT）、会话过期                                                  | §10.5（会话与 host 离线期的语义）、§4.5                               | QoS 1/2 我们**不做**：载荷已密封且 relay 不能重放，重投由 §10.2 的幂等语义兜底                              |
| [Postel 的稳健性原则](https://www.rfc-editor.org/rfc/rfc8722)                                              | "发得笨，收得客气"：实现 MUST 容忍自己不发的东西                                               | §15.2 未知字段/未知帧的容忍义务                                       | 过度宽容会让真实 bug 静默——所以宽容有边界：未知**字段** strip，未知**帧名** 记日志后丢弃                    |

### 2.3 一条借用原则

借用的每一条都要能回答："**如果不这么做，出错时长什么样？**" 回答不了的，本规范不接受它。
下面三条是反例（业界这么做，我们不做）：

1. **HTTP 状态码语义**：我们的传输是 WS，没有请求-响应的行文，搬过来只会多一层映射。
2. **CloudEvents 的 `time`**：两端时钟都不可信（§4.5），一个不可信的时间戳比没有更糟。
3. **MQTT 的 retain**：中继是零知识的，它连密文都存不住，retain 等于要求它持有载荷。

---

## 3. 一致性语言

本文用的 MUST / MUST NOT / REQUIRED / SHALL / SHOULD / SHOULD NOT / MAY / OPTIONAL
按 [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) 与
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) 解释，**且大小写敏感**。

三类实体：

| 实体       | 含义                                    |
| ---------- | --------------------------------------- |
| **host**   | 宿主插件实现                            |
| **relay**  | 中继实现                                |
| **client** | 小程序实现（含它那套独立实现，见 §7.1） |

未特别标注时，义务落在**协议的对应角色**上；一条义务若涉及两个角色，会分别写出。

---

## 4. 传输层契约（L4）

### 4.1 端点与握手

- relay MUST 接受 `/` 与任意路径上的 WebSocket upgrade（契约 T6）。
  收窄成 `/ws` 会让**已发布的配对地址全部连不上**——这不是洁癖问题，是运营事故。
- TLS 终止是**部署方的责任**（契约 §14 与 `docs/SECURITY.md`）。relay MUST NOT 假定传输是明文安全的；
  生产部署 MUST 使用 `wss://`。

### 4.2 帧类型与大小

| 编号   | 义务                                                                      | 说明                                                                                                                                       |
| ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **T1** | 端点 MUST 只发送**文本**帧；relay MUST 以 `error{bad_frame}` 拒收二进制帧 | 小程序把 `onMessage` 的 `data` 直接交给 `JSON.parse`，收到二进制是**静默丢弃**。这条是"主机侧看不到任何报错，手机侧什么都不发生"的经典成因 |
| **T2** | relay MUST 以 **1009** 关闭超过 `maxPayload` 的消息                       | 历史值 256 KiB；现网默认 1 MiB（`DRC_MAX_MSG_BYTES`）。**收紧它等于直接掐断流式输出**                                                      |
| **T3** | relay MUST 对同一 conversation 的帧保持**串行投递**                       | client 没有去重/排序能力（§10.1）                                                                                                          |

### 4.3 线格式

#### 4.3.1 一条帧 = 一个 JSON 文本消息

- 帧 MUST 是单个 JSON **对象**（不是数组、不是标量）。
- MUST NOT 含 `NaN` / `Infinity`（[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259#section-6）不允许它们成为合法 JSON），
  也不得含尾随逗号。

#### 4.3.2 接收方的解析纪律（[RFC 8722](https://www.rfc-editor.org/rfc/rfc8722) 的收窄版）

| 步骤                                       | 失败 →                 |
| ------------------------------------------ | ---------------------- |
| 1. 是文本帧？                              | `error{bad_frame}`     |
| 2. `JSON.parse` 成功？                     | `error{bad_json}`      |
| 3. 顶层是对象？                            | `error{bad_json}`      |
| 4. 有字符串 `t`？                          | `error{bad_json}`      |
| 5. `t` 在协议注册表里？                    | `error{unknown_frame}` |
| 6. 通过对应 schema？                       | `error{bad_frame}`     |
| 7. `enc`/`enc-batch` 的密文是标准 base64？ | `error{bad_frame}`     |

**5 与 6 必须分开**，它们对排错的价值完全不同：前者是"对端版本不对"，后者是"对端发了坏数据"。
把它们合并的错误信息会把后者误读成前者——而这条误读在历史上真的发生过
（`dsh-remote-server/src/server.ts:678-695` 的注释记着）。

> **实现义务**：relay MUST 用协议包提供的分类器完成第 5–7 步，
> MUST NOT 自己维护一份帧名清单（现状见附录 D·GAP-1）。

**重复键**：接收方 MUST NOT 依赖"最后一个键胜出"。实现 SHOULD 拒绝含重复键的帧；
若不拒绝，则 MUST 在文档中声明采用"最后一个键胜出"，并保证两端一致。

#### 4.3.3 大小上限的同源性

- 协议层 MUST 导出 `MAX_RELAY_MESSAGE_BYTES`（当前 1024×1024），它是中继 `DRC_MAX_MSG_BYTES` 的**默认**。
- 密文上限 MUST 由此倒推：`MAX_CIPHERTEXT_BYTES = MAX_RELAY_MESSAGE_BYTES − 8 KiB`。
- client MUST 在**发送前**估算整帧体积并拦下超限的消息，且拦在**清空输入框之前**——
  否则用户要重打一遍。
- 依据：base64 胀 4/3，再加 24 B nonce + 16 B Poly1305 MAC 的封装。
  这条曾经写错过一次（密文上限 512 KiB < 手机附件闸门 512 KiB 原始字节），
  症状是"图片发不出去"，而两层各自都觉得自己是对的（`frames.ts:32-48`）。

### 4.4 保活

- 保活 MUST 由 **WS 层的 ping/pong** 承担（契约 T4）。
  client 与 host MUST NOT 发应用层 `ping`：改判应用层心跳会周期性踢掉空闲客户端
  （小程序的 socket 在后台被回收，靠的是重连而不是心跳）。
- 收到 `ping` MUST 回 `pong`（relay 侧）；endpoint 收到 `pong` MUST 丢弃。

### 4.5 没有可信时钟

任何一端 MUST NOT 用本地时钟给对端"多久之后"做判断：

- `ping.ts` / `pong.ts` 只用于**测量**，不得作为超时依据；
- 所有权威寿命（配对码 TTL、会话回收）MUST 由 relay 计算并下发（`pair-ready.ttlMs`）。
  历史事故：`host` 用本地 TTL 覆盖服务端 TTL，于是"手机上还剩很久、实际刚过期"。

---

## 5. 连接生命周期、版本与能力协商（L3 入口）

### 5.1 状态机

```
endpoint                                     relay
   │                                            │
   ├─ hello{role, protocol, clientId|hostId|token, capabilities?} ──►│
   │                                     认证 / 分配权威 id          │
   │◄─ hello-ok{role, clientId|hostId, protocol, capabilities?} ────┤
   │  （client 恒必须收到 hello-ok：契约 F4）                          │
   │                                            │
   ├─ pair-begin{pairingToken}（host）────────►│      ──► pair-ready{ttlMs} → host
   ├─ pair-begin-client{pairingToken}（client）►│      ──► paired{sessionId, hostId} → client
   │                                            │      ──► peer-joined{sessionId, clientId, pairingToken} → host
   │                                            │
   │◄══════════ enc / enc-batch ══════════════►│
   │                                            │
   ├─ session-leave{sessionId}（client）──────►│      ──► peer-left{sessionId, clientId, unpaired?}
   │                                            │
   ├─ resync{sessionIds[]}（host，鉴权后立即）──►│
   │                                            │
   ├─ ping ───────────────────────────────────►│ ──► pong
```

**命名要点**：注册帧统一为 `hello`（host 与 client 共用，靠 `role` 区分），
失败统一为 `error{code}`。历史上是 `auth`/`hello` 两套并存，两个失败面
（`auth-fail{reason}` 与 `error{code}`），排错时要看两处文档（`frames.ts:15-19`）。

### 5.2 版本协商（MUST）

| 编号   | 义务                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **V1** | `hello.protocol` MUST 是正整数，缺省视为 `1`（兼容既有小程序）                                                                                                     |
| **V2** | relay MUST 在 `hello-ok.protocol` 回**它自己**的版本；host/client MUST NOT 因此中断连接                                                                            |
| **V3** | 收到 `hello-ok.protocol` 后，端点 MUST 校验 `MIN_SUPPORTED ≤ protocol ≤ 自身版本`。不满足时 MUST 以 `error{unsupported_protocol}` 明确告知用户，并停止发送数据面帧 |
| **V4** | 版本不匹配 MUST NOT 表现为"连上了但什么都不发生"。这是本协议最重要的一条可用性纪律                                                                                 |

> **为什么不用 SemVer 做线协议版本**：三端发版节奏不同（宿主跟着 DSH 走、relay 是单文件产物、
> 小程序要过体验版审核），硬性版本对齐会把"某端晚几天升级"变成"全线不可用"。
> 现行做法是**加性演进**（§15），版本号只作为**能力陈述**而不是闸门。

### 5.3 能力协商（SHOULD）

`hello` 与 `hello-ok` 携带可选的 `capabilities: string[]`。

| 编号   | 义务                                                                   |
| ------ | ---------------------------------------------------------------------- |
| **C1** | 能力 id MUST 取自 §17.4 的注册表；未注册的 id 接收方 MUST 忽略         |
| **C2** | 能力协商 MUST NOT 取代版本校验：两者都要有（V3 用于拒绝，C2 用于降级） |
| **C3** | 发送方 SHOULD 只声明自己**本次连接**真实支持的能力                     |
| **C4** | 能力列表 MUST NOT 包含秘密                                             |

> **这条为什么不是鸡肋**：`exp.model` 就是"能切/不能切"必须分两种表现的反面教材——
> 早期靠"有没有 options"去推断，在清单恰好为空的那一轮静默错成不可切。
> 能力与限额（§13）应当被**显式**上报，而不是让对端从形状里猜。

---

## 6. 身份与配对

### 6.1 `dshr:` 配对 URI

#### 6.1.1 语法（契约 B8）

```
dshr:/p?v=1&s=<ws(s) 地址>&n=<主机名>&psk=<base64 16B>[&t=<6 位码>]

dshr   = "dshr:"
p      = "/" "p"
```

#### 6.1.2 MUST

| 编号   | 义务                                                            | 理由                                                                     |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **U1** | 生成侧 MUST 用 `URLSearchParams`（或等价编码器），MUST NOT 手拼 | base64 里的 `+` 未编码会在两侧解析出不同结果                             |
| **U2** | `dshr:/p` 之后 MUST NOT 有 `//`                                 | 按 WHATWG URL 解析的实现会把 query 丢掉                                  |
| **U3** | 解析侧 MUST 要求 path 恰为 `/p`                                 | 文档语法如此；宽松会让"另一张码"也解析成功                               |
| **U4** | `s` MUST 以 `ws://` 或 `wss://` 开头                            | 拿一条必然连不上的地址去试，不如当场判"这张码不对"                       |
| **U5** | `psk` MUST 像标准 base64（**只查字符集，不查长度**）            | 长度由 client 在连接那一步再判，"扫码预览"与"真正连接"分两级报错才对得上 |
| **U6** | `t` 仅当 `/^\d{6}$/` 命中才采纳，否则按**缺省**处理             | 一个坏的 t 不该让整张码作废                                              |
| **U7** | 任何畸形输入 MUST 返回 null（绝不抛）                           | 调用方据此弹"无法识别"                                                   |
| **U8** | 解析器 MUST 保留"未编码 `+`"的重试路径                          | 小程序那份手写 query 解析器就是这样，两侧必须合流到同一结果              |

#### 6.1.3 PSK

- MUST 是 16 字节 CSPRNG（`randomBytes`），base64 后 24 字符。
- MUST 每次配对轮换，**单次有效**（契约 B7）。
- MUST NOT 过网给 relay（偏离 D1，`pair-begin` 不带 psk 字段）。

#### 6.1.4 诚实的边界（未做到的事）

- `dshr:` **没有**按 RFC 7595 正式注册；本文只固定语法。
- QR **携带 PSK 明文**：拍到二维码 = 拿到这条通道的长期密钥。这条限制来自
  "小程序无 CSPRNG 假设下仍要完成对称密钥建立"（§7.5），不是疏忽。
- 6 位码在 QR 里是**可选**的；带码时它对密码学**不增加**任何保证，
  它的价值是"人眼可核对"与"支持分离的两步配对（码在另一条通道上给）"。

### 6.2 配对状态机与失败原因

| 帧                  | 方向           | 义务                                                                      |
| ------------------- | -------------- | ------------------------------------------------------------------------- |
| `pair-begin`        | host → relay   | MUST 带 6 位 `pairingToken`；MUST NOT 带 PSK                              |
| `pair-ready`        | relay → host   | MUST 带**服务端权威** `ttlMs`；host MUST 用它覆盖本地过期时间             |
| `pair-begin-client` | client → relay | MUST 只带 `pairingToken`                                                  |
| `paired`            | relay → client | MUST 带 `sessionId` 与 `hostId`（契约 F4：缺 `sessionId` 后面全部解不开） |
| `pair-fail`         | relay → client | `reason` MUST 取自那**四个**冻结值                                        |
| `peer-joined`       | relay → host   | 发给 host 的那一份 MUST 带 `pairingToken`（host 按它取 PSK）              |

`pair-fail.reason ∈ {invalid_or_expired, already_used, host_offline, bad_token}`

> **为什么只有四个**：它们是**冻结消费面**——小程序有一张逐字的中文映射表，
> 多一个就把英文字面量弹到用户脸上。中继内部的限流原因（`rate_limited`）MUST 记进日志，
> 落到线上的 `reason` MUST 是这四个之一。这条有机械防线：
> `e2e/protocol.test.mjs` 直接从 `dsh-remote-mp/miniprogram/core/client.js`
> 解析出映射表的键再比对枚举。

### 6.3 6 位码的在线枚举（已知风险，MUST 量化披露）

码空间 10⁶ ≈ 19.9 bit。relay MUST 同时具备**单连接**与**全局**配额：

| 变量                         | 默认   | 触发                        |
| ---------------------------- | ------ | --------------------------- |
| `DRC_PAIR_ATTEMPTS_PER_CONN` | 5      | close **4008**              |
| `DRC_PAIR_GLOBAL_PER_SEC`    | 20     | 记 `rate_limited`           |
| `DRC_PAIR_TTL_MS`            | 120000 | 过期 → `invalid_or_expired` |
| `DRC_MAX_PENDING_PAIRS`      | 1000   | `error{pair_table_full}`    |

量化：默认 TTL 下一个窗口内最多被猜 ≈ 20 × 120 s = 2400 次 ≈ **0.24%**。
部署方 MUST 在反向代理层再叠一层按 IP 的速率限制（relay **不读** `X-Forwarded-For`，
因为那是一条可伪造的头）。

**猜中能得到什么**（必须如实写进任何对外文档）：猜中码 ≠ 拿到明文。攻击者拿不到 PSK，
收得到下行密文但解不开、发不出主机能解开的上行（连续两帧解不开后 host 作废该通道）。
实际收益是三件较弱的事：① 抢占这张一次性码；② 短暂占住一个配对席位，
可能把审批/提问卡抢走；③ 一条只对自己有效的路由席位。

---

## 7. 密码学层（L2）

### 7.1 冻结字节级契约（附录 A 的摘要）

> 这一节的任何改动都是**破坏性**的：client 侧有一份**独立实现**
> （`dsh-remote-mp/miniprogram/core/codec.js`），两侧由 golden vector 与现跑对拍锁死。
> 改动 = 必须同时改两端 + 重新生成 `e2e/fixtures/wire-vectors.json`（否则
> `e2e/protocol.test.mjs` 的 codec sha256 新鲜度检查会红）。

| 编号   | 内容                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | `ciphertext = base64( nonce(24B) ‖ secretbox( utf8(JSON.stringify(payload)), nonce, key ) )`，外层对象**只有一个字段** `ciphertext`           |
| **B2** | base64 = 标准表（`+` `/` `=`、带 padding）                                                                                                    |
| **B3** | `open()` 的任何失败 MUST 返回 null，MUST NOT 抛                                                                                               |
| **B4** | `kdfHash(parts) = SHA-512(p0 ‖ 0x1f ‖ p1 ‖ 0x1f ‖ … ‖ pn ‖ 0x1f)[0..32]`——**含最后一个之后的分隔符**                                          |
| **B5** | 会话密钥 parts 顺序固定 `['dsh-rc/v1', dir, convId, pskRawBytes]`，`dir ∈ {c2h, h2c}`，PSK 参与运算的是**解码后的字节**                       |
| **B6** | client 侧 nonce = `kdfHash(['dsh-rc/v1/nonce', installId, convId, psk])[0..16] ‖ counter(8B **大端**)` = 24 B；host→client 方向可用随机 nonce |
| **B7** | PSK = 16 字节，base64 24 字符，每次配对轮换                                                                                                   |
| **B8** | 配对 URI 见 §6.1.1                                                                                                                            |
| **B9** | 字符串常量：`'dsh-rc/v1'`、`'dsh-rc/v1/nonce'`、`'c2h'`、`'h2c'`、`0x1f`、`'ciphertext'`、`'dshr:/p?'`、参数名 `v/s/n/psk/t`、`'dsh'`、`'c_'` |

### 7.2 记录封装

- 密封算法：[NaCl secretbox](https://nacl.cr.yp.to/secretbox.html)（XSalsa20-Poly1305）。
  **没有** Node 内置等价（`crypto.getCiphers()` 过滤 `salsa` 为空），所以用 `tweetnacl`。
- 记录最小长度 = 24 + 16 = 40 字节，更短的 MUST 直接判失败。
- 发送方 MUST NOT 在同一把密钥下复用 nonce（§10.6）。

### 7.3 密钥派生（KDF）

```
key = SHA-512( 0x1f-terminated-parts )[0..32]
```

#### 7.3.1 为什么不是 HKDF（RFC 5869）

| 理由     | 事实                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| 兼容性   | 现有 client 的 `codec.js` 已经发布并逐字节实现；换 KDF 等于重发一个版本                                       |
| 等价性   | 本项目的 KDF 是 HMAC-free 的 SHA-512 拼接式，**不是** HKDF                                                    |
| 升级路径 | 若将来引入 HKDF-SHA512，必须换**命名空间**（`dsh-rc/v2`）而不是就地改参数，否则两侧会静默派生出两把不同的钥匙 |

> **判断**：就地改 KDF 是本项目历史上最贵的一类改动（"配对显示成功，但每一帧都解不开"）。
> 任何 KDF 改动 MUST 走新命名空间 + 新协议版本 + 双轨并存期。

### 7.4 方向密钥分离

- `c2h` 与 `h2c` MUST 是不同的密钥（§7.1 B5 天然保证）。
- 方向分离保证：一条方向被攻破**不直接**给出另一条方向的密钥。
- 它**不**保证前向保密（见 §7.6）。

### 7.5 为什么 v1 是 PSK 而不是 X25519（诚实的说明）

| 事实                                                                                                              | 位置                       |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 小程序侧 vendored 的 `nacl-fast` 只保留 `crypto.getRandomValues` 一条路径，**宁可抛错也不退化到 `Math.random()`** | `core/vendor/nacl-fast.js` |
| `codec.seal()` **强制**要求显式 24 字节 nonce，手机的加密入口根本不调 `nacl.randomBytes()`                        | `core/codec.js:131-141`    |
| X25519 密钥生成必须有 CSPRNG，而这条链路上**没有办法验证**容器给的是不是真随机                                    | ——                         |

PSK 方案在 v1 成立的条件，逐条都在代码里：PSK 由 Node 侧 CSPRNG 生成、每次配对轮换；
线格式两侧逐字节一致（golden vectors + 现跑对拍双层）；
nonce 唯一性有论证（§10.6）。

### 7.6 v2 路线图（规范性指引，**尚未实现**）

v1 的三条已知弱点，MUST NOT 被文档描述成不存在：

| #   | 弱点                            | v2 的做法                                                                            | 业界依据                                                                   |
| --- | ------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 1   | **无前向保密**                  | 每方向引入消息棘轮：`(msgKey_n, chainKey_{n+1}) = KDF(chainKey_n)`，每条消息推进一次 | [Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) §5 |
| 2   | **PSK 泄露 = 全部历史流量可解** | 配对时用 X25519 做一次 ECDH 得到初始 chain key（PAKE/QR 引导），PSK 只作认证         | [X3DH](https://signal.org/docs/specifications/x3dh/) §4                    |
| 3   | **无重放窗口**                  | 棘轮天然给出每方向单调的消息计数，接收端维护滑动窗口                                 | §10.2                                                                      |

**约束**：v2 MUST 以新命名空间（`dsh-rc/v2`）与新协议版本落地，MUST NOT 原地替换；
两端 MUST 在过渡期同时支持 v1 与 v2（按 `hello.capabilities` 声明 `drc.crypto.v2`）。

---

## 8. 控制面帧目录（L3）

> 完整字段定义见 [`src/wire/frames.ts`](./src/wire/frames.ts)（唯一事实源）。
> 本节给出**规范性**的语义与义务。

### 8.1 endpoint → relay

| `t`                 | 必填字段                        | 语义与义务                                                                              |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| `hello`             | `role`                          | 注册。host 可带 `token`（出站凭据），client 可带 `clientId` / `clientMeta`              |
| `pair-begin`        | `pairingToken`                  | host 发布一次性码。MUST NOT 带 PSK                                                      |
| `pair-begin-client` | `pairingToken`                  | client 认领码                                                                           |
| `resync`            | `sessionIds[]`                  | host 声明"我此刻仍持有密钥的会话"。relay MUST 删掉未列出的；MUST NOT 因此发 `peer-left` |
| `enc`               | `sessionId`, `ciphertext`       | 一条密封记录。`seq` 是元数据                                                            |
| `enc-batch`         | `sessionId`, `items[]`（1–200） | 批量记录。**顺序即投递顺序**                                                            |
| `session-leave`     | `sessionId`                     | 显式退出某个会话（与"断线"语义不同，见下）                                              |
| `ping`              | ——                              | 可选；生产路径不用（§4.4）                                                              |

### 8.2 relay → endpoint

| `t`           | 必填字段                | 语义与义务                                                                 |
| ------------- | ----------------------- | -------------------------------------------------------------------------- |
| `hello-ok`    | `role`                  | MUST 带权威 `clientId`（client 会采纳并覆盖本地安装 id）                   |
| `pair-ready`  | `pairingToken`, `ttlMs` | 服务端权威 TTL                                                             |
| `paired`      | `sessionId`, `hostId`   | 通道建立                                                                   |
| `pair-fail`   | `reason`                | 四值枚举（§6.2）                                                           |
| `peer-joined` | `sessionId`             | 发给 host 的那份 MUST 带 `pairingToken`                                    |
| `peer-left`   | `sessionId`, `clientId` | **对 client 而言唯一合法触发：host 离开**。可选 `unpaired:true` = 主动解配 |
| `error`       | `code`                  | §12                                                                        |
| `pong`        | ——                      |                                                                            |

### 8.3 `session-leave` 与断线必须可区分（MUST）

发给 host 的 `peer-left` 有两个现场长得一模一样的触发：

- client 点了「解除配对」（发 `session-leave`）：它清了自己的 convId，**再也不会回来**；
- client socket 断了（切后台、断网）：会话 MUST 留存（D3），回前台还要用。

因此：**带 `unpaired:true` = 主动解配**，host MUST 把会话一并作废；
不带 = 断线，host MUST 保留会话。
该字段 MUST 是可选的——老 relay 不带，host MUST 仍按"断线"处理。

### 8.4 `resync` 为什么必需

D3/D6 让会话跨断连存活之后出现了旧实现没有的死角：**host 进程重启**（PSK 随之消失）
而 relay 不知道，于是它继续把 client 发来的密文转发给一个解不开的 host；
client 既收不到回复、也收不到 `unknown_session`，表现是"永远转圈且没有任何提示"。

⇒ relay 自己的表命中与否**不能**代表 host 是否还认得这个会话。

---

## 9. 数据面载荷目录（L1）

### 9.1 命名与容错

- 类型名 MUST 是 `cmd.*`（client→host）或 `ev.*`（host→client）。
- 接收方 MUST 忽略不认识的 `t`（client 的分发是一条**没有 else 的 if 链**，
  未命中 = 什么都不发生，连日志都没有）。
- ⇒ 新增类型名是安全的；**挪用既有名字的语义不是**。

### 9.2 命令（client → host）——封闭集合

> **封闭**是安全属性，不是实现细节：手机能让这台机器做的事，就是这张表里的这几条。
> 没有任意工具执行、任意文件路径、任意 shell。

| `t`                      | 必填                                             | 语义                                                |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| `cmd.send_prompt`        | `cmdId`, `sessionId`, `text`                     | 发指令。可选 `images[≤4]` / `files[≤4]`             |
| `cmd.list_sessions`      | `cmdId`                                          | 请求会话列表；host MUST 额外推 `ev.session_changed` |
| `cmd.interrupt`          | `cmdId`, `sessionId`                             | 中断当前回合                                        |
| `cmd.answer`             | `cmdId`, `sessionId`, `requestId`, `answers[≥1]` | 回答提问                                            |
| `cmd.resolve_permission` | `cmdId`, `sessionId`, `requestId`, `decision`    | 审批决定，逐字回传 host 下发的 `options[].id`       |
| `cmd.keep_awake`         | `cmdId`, `enabled`                               | 防休眠开关，可选 `idleReleaseSec`                   |
| `cmd.session_history`    | `cmdId`, `sessionId`                             | 读历史，游标分页（§10.4）                           |
| `cmd.new_session`        | `cmdId`                                          | 新建会话，可选 `workspace`（目录绝对路径）          |
| `cmd.get_pending`        | `cmdId`                                          | 拉还挂着的审批/提问，可选 `sessionId`               |
| `cmd.archive_session`    | `cmdId`, `sessionId`                             | 归档（缺省）/ 取消归档（`archived:false`）。见 A-1  |

**每条 `cmd.*` 的 MUST：**

| 编号    | 义务                                                                     |
| ------- | ------------------------------------------------------------------------ |
| **P-1** | MUST 带 `cmdId`，且 host MUST 原样回传到 `ev.result.cmdId`               |
| **P-2** | client MUST NOT 在一个 conversation 内复用 `cmdId`（幂等窗口见 §10.2）   |
| **P-3** | host MUST 对非法载荷回 `ev.result{ok:false, message}`，MUST NOT 静默丢弃 |
| **P-4** | host MUST NOT 让一条密文决定宿主被怎么调用：解密后必须先过 schema        |

### 9.3 事件（host → client）

| `t`                                                | 关键字段                                          | 语义                                                                                 |
| -------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ev.session_changed`                               | `sessions[]`                                      | **全量快照**，会话列表的唯一数据源                                                   |
| `ev.message_delta`                                 | `messageId`, `delta`                              | 流式正文；每条消息最终 MUST 有一条 `done:true`，**空文本的 done 帧也不可被合并丢弃** |
| `ev.tool_event`                                    | `callId`, `phase`                                 | 同一次调用稳定唯一，client 用它原位更新同一行                                        |
| `ev.permission_request` / `ev.permission_resolved` | `requestId`                                       | 审批卡的开与收                                                                       |
| `ev.question_request` / `ev.question_resolved`     | `requestId`                                       | 提问卡的开与收                                                                       |
| `ev.run_state`                                     | `state ∈ {running, idle}`                         | 只有这两个值会让 client 收起挂着的卡                                                 |
| `ev.todo`                                          | `todos[]`                                         | **全量快照**                                                                         |
| `ev.retry`                                         | `attempt`, `max`, `reason?`                       | 正在重试                                                                             |
| `ev.compaction`                                    | `state ∈ {started, ended, failed}`                | **failed 与 ended 是两件事，不许合并**                                               |
| `ev.keep_awake_state`                              | `enabled`, `active`, `platform`, `backend`        | **不带 `sessionId`**（契约 F11）                                                     |
| `ev.model`                                         | `sessionId`, `model`, `canSwitch`                 | 模型是**按会话**的；`canSwitch` MUST 由生产侧显式给出                                |
| `ev.result`                                        | `cmdId`, `ok`                                     | 命令回执                                                                             |
| `ev.session_history`                               | `sessionId`, `cmdId`, `items[]`, `nextBeforeSeq?` | 一页历史                                                                             |

**历史为什么复用实时载荷**（§9.3 的 `ev.session_history.items[]`）：
client 侧的块流模型已经把 `ev.message_delta` 与 `ev.tool_event` 的回放规则写死了一遍。
历史若另立形状，同一套规则就要写第二遍，而两份实现迟早分叉——
表现是"实时看着对、历史看着怪"，这种缺陷很难靠肉眼发现（Matrix 用同一套事件形状处理 sync 与回放，同此理）。

### 9.4 三个最容易出事的生产侧陷阱

| 陷阱                                                          | 规则                                                 | 出错的样子                                                           |
| ------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `updatedAt` 给了数字时间戳                                    | MUST 是 ISO-8601 字符串，生产侧用 `isoOrUndefined()` | client 整页渲染抛错，而异常被 `emit()` 吞掉 ⇒ **会话列表静默不更新** |
| `ev.keep_awake_state` / `ev.session_changed` 加了 `sessionId` | MUST NOT（契约 F11）                                 | chat 页当作"别的会话"丢弃                                            |
| `decision` 用 `options[].id` 之外的值                         | MUST 逐字回传                                        | 审批落空且 host 已结算，桌面上"点了没反应"                           |

---

## 10. 交付语义

### 10.1 顺序

- relay MUST 对同一 conversation、同一发送方的帧保持串行投递（契约 T3）。
- 发送方 MUST 按产生顺序发送。
- 接收端 MUST NOT 假设跨 conversation 的顺序。

### 10.2 幂等（at-most-once 执行）

> 借鉴 [Stripe 的 idempotency key](https://docs.stripe.com/api/idempotent_requests) 与
> IETF `Idempotency-Key` 草案的思路：请求 id 不是日志字段，而是**语义契约**。

| 编号   | 义务                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| **I1** | `cmdId` 在一个 conversation 内 MUST 唯一                                                                                 |
| **I2** | host MUST 记住最近 `IDEMPOTENCY_WINDOW_MS`（默认 5 分钟）内已执行的 `cmdId`                                              |
| **I3** | 重复的 `cmdId` MUST NOT 再次执行；host MUST 重发同一 `ev.result`（同 `cmdId`，`ok` 与原答复一致，`data.deduped = true`） |
| **I4** | 该窗口 MUST 可配置，且 MUST ≥ client 的最大重试间隔                                                                      |

> **为什么这条值钱**：client 在超时/重连后会重发命令。没有幂等时，
> `cmd.send_prompt` 会**执行两次**——用户看到的是"我说了一遍，它回了两遍"。
> `cmd.resolve_permission` 执行两次的后果更糟（第二次落在一个已经关闭的请求上）。
> 现状见附录 D·GAP-4。

### 10.3 重放

- L2 的 Poly1305 MAC 使密文**不可篡改**，但不阻止**重放**。
- 数据面的重放防御是 §10.2 的 `cmdId` 去重。
- host MUST NOT 在同一 `(sessionId, messageId, part)` 上发出两条内容不同的 `ev.message_delta`
  （否则 client 会把不同消息拼成一段）。

### 10.4 离线与补拉

| 编号   | 义务                                                                                          |
| ------ | --------------------------------------------------------------------------------------------- |
| **R1** | client 在（重）连上后 MUST 发一次 `cmd.list_sessions`，收到 `ev.session_changed` 才宣布"在线" |
| **R2** | client 进入会话页 MUST 发一次 `cmd.get_pending`，补拉还挂着的审批/提问                        |
| **R3** | host MUST 把 `pending` 里还挂着的按**原 `requestId`** 重发；已结算的 MUST NOT 复活            |
| **R4** | `peer-joined` 的重发 MUST NOT 顺延到期时刻（MUST 用最初那一帧的 `expiresAt`）                 |
| **R5** | 历史 MUST 用游标分页：`nextBeforeSeq` 在 = 还有更早一页；**没有这个字段 = 最初一页**          |

> **为什么"没有游标"就等于"到底了"，而不用 `hasMore`**：两个字段表达同一件事，
> 迟早会出现"说还有、却没给游标"这种自相矛盾的载荷，而它的表现是
> 「加载更早」点了没反应，且**没有任何报错**。一个字段就没有这种状态。

### 10.6 会话归档

| 编号   | 义务                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------- |
| **A1** | host MUST NOT 因为 `cmd.archive_session` 而**中断**会话。仍在运行的会话 MUST 回 `ev.result{ok:false}` |
| **A2** | host MUST NOT 静默成功：不支持归档的一代 MUST 回 `ev.result{ok:false, message}` 说明原因              |
| **A3** | 归档成功后 host MUST 补推一次 `ev.session_changed`（本端不消费 `workspace/changes`）                  |
| **A4** | 协议 MUST NOT 提供"连带停止"这个参数（见下）                                                          |

> **A1 为什么不是"自动停掉"**：内核的 `archiveSession(sessionId, { stopActivity: true })`
> 能强行归档一条正在跑的会话，但那是**用户在手机上的一次误点**换来的主机上正在跑的工作被停掉。
> 不可逆的损失，且违反"插件不改变宿主自己的行为"这条纪律。所以正确行为是明确拒绝，
> 让用户回工作台停 —— 代价是他要多走几步，收益是不会误伤。
>
> **A3 为什么 host 自己不推就行**：归档这件事本端是知道的（它刚做完），
> 而 `workspace/changes` 那一帧只有 `{turn:N}`、不含"改了哪些文件"
> （伞仓 HANDOFF §8 P0-2 的取证结论），从中**推不出**归档了哪一条。
> 等下一次周期刷新会让用户看着列表没变而以为没生效。

### 10.5 会话与离线

- 会话 MUST 跨 client 断连存活（D3），直到：host 自身重启 / relay 回收 / `session-leave`。
- relay MUST NOT 因为 host 暂时离线就删除会话；MUST 以 `host_unavailable` 明确区分于 `unknown_session`
  （client 见到后者会清配对并要求重扫，而前者只是"这条指令没人接"，重试即可）。
- 镜像 [MQTT 的 Session Expiry](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html#_Toc3901114) 的取舍。

### 10.6 nonce 唯一性

| 编号   | 义务                                                          | 落点                                        |
| ------ | ------------------------------------------------------------- | ------------------------------------------- |
| **N1** | 发送方 MUST NOT 在同一把密钥下复用 nonce                      | client 计数器单调；host 随机                |
| **N2** | client 的计数器 MUST **先落盘再使用**；落盘失败 MUST 拒绝发送 | 内存计数往前走、盘上没动 ⇒ 重启后复用 nonce |
| **N3** | 计数器允许出现空洞；任何一方 MUST NOT 推断"下一个应该是几"    | 丢帧与发送失败都会跳过值                    |
| **N4** | 计数器 MUST NOT 回退到 0 重发                                 | `e2e/mp-client.test.mjs` 钉住               |

**唯一性论证**：会话密钥绑定 `(PSK, convId, 方向)`，nonce 前缀又绑定 `installId`；
存储被清空时 `installId` 与配对一起消失 ⇒ `(key, nonce)` 不可能复用。

---

## 11. 流控与预算

### 11.1 三层预算（必须同源）

| 层     | 常量                      | 值               | 谁执行                   |
| ------ | ------------------------- | ---------------- | ------------------------ |
| relay  | `DRC_MAX_MSG_BYTES`       | 1 MiB（默认）    | 超过 → close 1009        |
| 协议   | `MAX_RELAY_MESSAGE_BYTES` | 1 MiB            | schema 拒绝超限密文      |
| 协议   | `MAX_CIPHERTEXT_BYTES`    | 预算 − 8 KiB     | 出站构造器抛错（不静默） |
| client | 附件闸 + 整帧估算         | 512 KiB 原始字节 | **发送前**拦截           |
| host   | 单文件 / 总量上限         | 配置项           | 收下时拒绝并说清         |

> **纪律**：这些数字 MUST 只有一个来源（协议包导出常量），三端各自写一遍的那个数
> MUST 由 `e2e/wire-surface.test.mjs` 的逐处比对钉住。
> 改一处不报错不变红，症状是"第 5 个附件静默消失"或"发出去就掉线"。

### 11.2 限速

relay MUST 有：连接数上限、单连接帧速率、配对尝试（单连接 + 全局）、
host 凭据尝试。触达时的表现 MUST 是明确的关闭码或错误码，
MUST NOT 是"静默丢弃"（§4.3.2）。

---

## 12. 错误模型

### 12.1 形状

```
{ "t": "error", "code": <枚举>, "message": <≤512 字符串>, "retryAfterMs": <正整数，可选> }
```

借鉴 [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) 的"机器可判 + 人可读并存"：
`code` 给程序，`message` 给人。

### 12.2 错误码与可重试性

| `code`                      | 含义                    | 可重试 | 端点应当的动作                                        |
| --------------------------- | ----------------------- | ------ | ----------------------------------------------------- |
| `bad_role`                  | role 不合法             | ❌     | 断开                                                  |
| `bad_token`                 | host 凭据错             | ❌     | 断开，提示配置                                        |
| `need_host` / `need_client` | 对端角色还没上线        | ❌     | 等待被叫                                              |
| `bad_pair`                  | `pair-begin` 形状非法   | ❌     | 主机侧记日志                                          |
| `pair_table_full`           | 待配对表满              | ✅     | 稍后重试（带 `retryAfterMs`）                         |
| `unknown_session`           | 会话不存在              | ❌     | **client 必须清配对并要求重扫**（唯一据此清配对的码） |
| `not_member`                | 发送方不是该会话成员    | ❌     | 断开                                                  |
| `host_unavailable`          | 会话在，主机不在        | ✅     | 重试；MUST NOT 清配对                                 |
| `bad_frame`                 | 形状非法                | ❌     | 修实现                                                |
| `bad_json`                  | 不是合法 JSON 对象      | ❌     | 修实现                                                |
| `unknown_frame`             | 帧名不在注册表          | ❌     | 对端版本不对                                          |
| `rate_limited`              | 限速                    | ✅     | 按 `retryAfterMs` 退避                                |
| `internal`                  | 中继内部错误            | ✅     | 重试                                                  |
| `unsupported_protocol`      | **（新）** 版本不可接受 | ❌     | 明确告知用户后停止                                    |

### 12.3 MUST

| 编号   | 义务                                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** | relay 发给 **client** 的错误 MUST 带**中文 `message`**。英文码落到用户脸上是最差的表现                                                          |
| **E2** | `rate_limited` 与 `pair_table_full` SHOULD 带 `retryAfterMs`（[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after) 的毫秒形态） |
| **E3** | 新增错误码 MUST 是**加性**的；client 对未知码 MUST 有兜底展示（现为 `message                                                                    |     | code`） |
| **E4** | 内部原因（限流命中次数、具体失败栈）MUST 只进日志，MUST NOT 进线上的码                                                                          |

---

## 13. 能力与限额上报

### 13.1 为什么要有

同一个"功能存在"，在手机上可能表现为**三种**不同的东西：可点、置灰、根本不出现。
从形状里推断必然在边界情形下静默错（§5.3 的 `ev.model` 就是实例）。
因此 host MUST **显式**上报能力与限额。

### 13.2 `ev.host_info`（**尚未实现**，见附录 D·GAP-5）

```
ev.host_info {
  host:  { platform, arch, profile?, carrier?, dshVersion? },
  caps:  string[],                    // §17.4 的能力 id
  limits:{ maxImageAttachments, maxFileAttachments, maxAttachmentBytes, maxTextChars },
  state: { sleep: 'caffeinate'|'systemd-inhibit'|'unsupported' }
}
```

| 编号   | 义务                                                                     |
| ------ | ------------------------------------------------------------------------ |
| **L1** | `caps` MUST 取自注册表                                                   |
| **L2** | `limits` MUST 是 host **此刻真正执行**的值（不是配置的名义值）           |
| **L3** | client MUST NOT 用"字段缺失"推断"不支持"，缺省按**不支持**处理并如实显示 |
| **L4** | host MUST 在（重）连上与能力变化时各发一次                               |

---

## 14. 安全义务

### 14.1 MUST

| 编号   | 义务                                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------------------- |
| **S1** | relay MUST **不 import** 任何密码学实现，只允许 import **类型**。构建产物里 MUST NOT 出现 crypto 代码（有产物级判据） |
| **S2** | relay MUST NOT 持有任何会话密钥：`pair-begin` MUST NOT 携带 PSK，relay MUST NOT 存储它                                |
| **S3** | 6 位码 MUST NOT 进 relay 的 info 级日志（完整码降到 debug）                                                           |
| **S4** | host MUST 在解密后先过 schema，MUST NOT 让非法载荷进 runtime                                                          |
| **S5** | 事件订阅 MUST 走白名单；waterfall 事件 MUST NOT 放行                                                                  |
| **S6** | 凭据落盘 MUST 是 0600；PSK MUST 每次配对轮换                                                                          |
| **S7** | client 侧 MUST NOT 在 nonce 计数器落盘失败时发送（N2）                                                                |
| **S8** | relay MUST NOT 读取 `X-Forwarded-For` 一类可伪造的头来做限流                                                          |

### 14.2 SHOULD

| 编号    | 义务                                                      |
| ------- | --------------------------------------------------------- |
| **S9**  | 配对输出 SHOULD 支持分离的两步配对（码走人眼、密钥走 QR） |
| **S10** | 日志值 SHOULD 统一截断（未认证即入日志的字段尤其）        |

### 14.3 MUST NOT 声称的事

写给用户的文档 MUST NOT 声称以下任何一条（它们都不成立）：

1. 猜中 6 位码就能读到内容（**不成立**，§6.3）；
2. 端到端加密意味着 relay 什么都不知道（**不成立**：relay 知道双方身份、时间、频次、convId、字节数）；
3. 有前向保密（**不成立**，v1 无棘轮，§7.6）。

---

## 15. 演进与兼容策略

### 15.1 版本规则

| 变更类型                     | 是否升 `PROTOCOL_VERSION` | 做法                               |
| ---------------------------- | ------------------------- | ---------------------------------- |
| 新增可选字段                 | ❌                        | 加性；老实现 strip（zod 默认行为） |
| 新增 `cmd.*` / `ev.*` 类型名 | ❌                        | 老 client 静默忽略（§9.1）         |
| 新增控制帧名                 | ❌                        | 必须落在 client 的 default 分支    |
| 新增错误码                   | ❌                        | 加性（E3）                         |
| 改字段名 / 改语义 / 删字段   | ✅                        | 破坏性                             |
| 改字节级契约（B1–B9）        | ✅                        | 必须换 KDF 命名空间 + 三端同版本   |

> **为什么加性变更不升版本**：升版本会把"两端版本必须配对"从建议变成硬要求，
> 而这三端的发版节奏根本不同步（小程序要过体验版审核）。

### 15.2 容忍义务（[Postel](https://www.rfc-editor.org/rfc/rfc8722) 的收窄版）

| 接收方             | MUST                                                              |
| ------------------ | ----------------------------------------------------------------- |
| 对未知**字段**     | 忽略（zod strip）。生产方 MUST NOT 因为"对端会 strip"就依赖它透传 |
| 对未知**帧名**     | 忽略并**记日志**（不是静默——排错时"没见过这个帧名"是第一条线索）  |
| 对未知**载荷类型** | 忽略                                                              |
| 对未知**能力 id**  | 忽略                                                              |
| 对未知**错误码**   | 有兜底展示                                                        |

### 15.3 禁止（这套协议历史上最贵的几类错误都出在这里）

| 编号   | 禁止                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------- |
| **X1** | 挪用既有帧名的语义（例：把心跳响应叫 `peer-left`，client 会每收到一次就丢一次配对）             |
| **X2** | 在分发链上"复制一份分支"（历史事故：`status` 分支复制成两份，第一份是空的，配对状态事件全被吞） |
| **X3** | 让某个限流/预算值**只**存在于三端中的一端                                                       |
| **X4** | 用"能连上但什么都不发生"表示任何一种不兼容                                                      |
| **X5** | 让 zod 的 strip 掩盖拼错的字段名（`updatedAt` → `updated_at` 在生产侧不会报错）                 |

---

## 16. 一致性要求（分角色）

### 16.1 client

- MUST 只发 §9.2 表内的命令；MUST NOT 发凭据。
- MUST 遵守 §4.2（T1 只发文本）、§6.1（U1–U8）、§10（N1–N4、I1）。
- MUST 在 2 次连续解密失败后丢弃配对（此阈值是 client 侧策略，协议层 MUST NOT 改它）。
- MUST NOT 把 `unknown_session` 之外的错误码当作"要重新配对"。

### 16.2 host

- MUST 遵守 §5.2（V3）、§8.1、§9.2（P1–P4、I2–I4）、§10.4（R3–R4）、§14.1（S4–S6）。
- MUST 在（重）连上后立刻发 `resync`（§8.4）。
- MUST NOT 对解密失败的帧做重试放大；连续失败 MUST 作废该通道。

### 16.3 relay

- MUST 遵守 §4.2（T1–T3）、§4.3.2（五种错误分流）、§5.2（V2）、§6.2、§11、§12、§14.1（S1–S3、S8）。
- MUST NOT 校验 `enc` 的 `seq` 单调（契约 F13：client 冷启动必从 1 重来）。
- MUST 在 `hello` 之后对 `clientMeta` 等未认证字段做长度上界（日志放大通路）。

---

## 17. 注册表

### 17.1 控制帧名

| 方向             | 名字                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| endpoint → relay | `hello` `pair-begin` `pair-begin-client` `resync` `enc` `enc-batch` `session-leave` `ping` |
| relay → endpoint | `hello-ok` `pair-ready` `paired` `pair-fail` `peer-joined` `peer-left` `error` `pong`      |

### 17.2 命令名

`cmd.send_prompt` `cmd.answer` `cmd.resolve_permission` `cmd.interrupt`
`cmd.list_sessions` `cmd.keep_awake` `cmd.session_history` `cmd.new_session` `cmd.get_pending`
`cmd.archive_session`

### 17.3 事件名

`ev.session_changed` `ev.message_delta` `ev.tool_event` `ev.permission_request`
`ev.permission_resolved` `ev.question_request` `ev.question_resolved` `ev.run_state`
`ev.todo` `ev.retry` `ev.compaction` `ev.keep_awake_state` `ev.model` `ev.result`
`ev.session_history`
（+ 规划中：`ev.host_info`）

### 17.4 能力 id（§5.3）

| id                                  | 含义                               |
| ----------------------------------- | ---------------------------------- |
| `drc.v1`                            | 基线：协议 1、PSK 配对、`enc` 载荷 |
| `drc.pairing.qr`                    | 支持 `dshr:` 二维码配对            |
| `drc.pairing.token`                 | 支持 6 位码单独输入                |
| `drc.payload.attachments`           | 支持 `images` / `files`            |
| `drc.payload.history`               | 支持游标分页历史                   |
| `drc.payload.new-session.workspace` | 支持 `cmd.new_session.workspace`   |
| `drc.payload.get-pending`           | 支持 `cmd.get_pending`             |
| `drc.payload.keep-awake`            | 支持防休眠                         |
| `drc.payload.archive-session`       | 支持 `cmd.archive_session`         |
| `drc.payload.model`                 | 支持 `ev.model`                    |
| `drc.payload.retry-compaction`      | 支持 `ev.retry` / `ev.compaction`  |
| `drc.cmd.idempotency`               | 声明本端做了 §10.2 的去重          |
| `drc.data.enc-batch`                | 支持批量密文帧                     |
| `drc.host.resync`                   | 声明本端会在鉴权后发 `resync`      |
| `drc.host.info`                     | 声明本端会发 `ev.host_info`        |
| `drc.crypto.v2`                     | （规划）支持消息棘轮               |

---

## 附录 A · 冻结字节级契约（B1–B9）

见 §7.1 的表格。每一条的两侧实现：

| 契约     | 协议包                                                   | 客户端第二实现                   | 机械锁定                                                   |
| -------- | -------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------- |
| B1/B2/B3 | `src/crypto/record.ts`、`src/crypto/bytes.ts`            | `core/codec.js:131-160`          | `e2e/mp-crypto.test.mjs`                                   |
| B4/B5/B6 | `src/crypto/keys.ts`                                     | `core/codec.js:101-183`          | `e2e/fixtures/wire-vectors.json` + `e2e/protocol.test.mjs` |
| B7       | `src/crypto/keys.ts:132`                                 | ——（只解析不生成）               | `tests/crypto/keys.test.ts`                                |
| B8       | `src/identity/pairing.ts`                                | `core/codec.js:200-237`          | 33 组向量对拍                                              |
| B9       | 分散在 `keys.ts` / `frames.ts` / `pairing.ts` / `ids.ts` | `codec.js:22-27`、`client.js:19` | `e2e/protocol.test.mjs`                                    |

> **反证手法**：去掉 KDF 末尾那个分隔符，向量立刻全红——这证明这套断言真的在守东西。

## 附录 B · 冻结帧契约（F1–F13）

| #   | 契约                                                                       | 规范位置     |
| --- | -------------------------------------------------------------------------- | ------------ |
| F1  | 帧名冻结：既有语义不得挪用                                                 | §8、§15.3 X1 |
| F2  | client 只发 3 类帧 + `session-leave`                                       | §16.1        |
| F3  | 双 `sessionId`                                                             | §1.4         |
| F4  | `hello` 之后必须 `hello-ok`；`paired` 必须带 `sessionId`                   | §5.1、§6.2   |
| F5  | `unknown_session` 是 client 唯一据此清配对的码                             | §12.2        |
| F6  | `pair-fail.reason` 四值冻结                                                | §6.2         |
| F7  | 会话列表唯一源 + `updatedAt` 必须是 ISO 字符串                             | §9.3、§9.4   |
| F8  | 收到 `cmd.list_sessions` 与任何状态变更后 MUST 额外推 `ev.session_changed` | §9.2         |
| F9  | 每条消息最终 MUST 有一条 `done:true`，空文本的 done 帧不可被合并丢弃       | §9.3         |
| F10 | `decision` 逐字回传；`answers[].freeText` 是整卡共享                       | §9.2         |
| F11 | `ev.keep_awake_state` 与 `ev.session_changed` MUST NOT 带 `sessionId`      | §9.3、§9.4   |
| F12 | `enc-batch` 的 `sessionId` 只在外层，客户端逐项解密并保持数组顺序          | §8.1         |
| F13 | relay MUST NOT 校验 `seq` 单调；`clientId` 弱随机非秘密                    | §16.3        |

## 附录 C · 传输契约（T1–T8）

| #   | 契约                                             | 规范位置    |
| --- | ------------------------------------------------ | ----------- |
| T1  | 只允许文本 JSON 帧                               | §4.2        |
| T2  | 帧大小上限（现网 1 MiB），超限硬断 1009          | §4.2、§11.1 |
| T3  | 同一会话 MUST 串行投递                           | §10.1       |
| T4  | 保活只能靠 WS 层 ping                            | §4.4        |
| T5  | 关闭码语义：`1001/1013/1009/1008/4001/4008/4000` | §4.1        |
| T6  | 根路径与任意路径都可 upgrade                     | §4.1        |
| T7  | `/healthz` 字段集；`/api/pair-status` 默认 404   | 中继手册    |
| T8  | 客户端 MUST NOT 硬编码中继域名                   | §6.1        |

## 附录 D · 现状与规范的差距（有序待办）

> 纪律：规范里 MUST 有而代码里还没有的，在这里记账；反过来，代码里有而规范没写的，
> 要么补进正文，要么删掉——**不允许两边都不管**。

| #     | GAP                                                              | 影响                                       | 落点                                          | 状态                                                |
| ----- | ---------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------- | --------------------------------------------------- |
| GAP-1 | relay 自己维护了一份帧名清单 `KNOWN_FRAME_NAMES`，并手写五步分流 | 协议表变了要改两处；漏改 = 错误码失真      | 协议包导出注册表 + 分类器，relay 删掉那份清单 | 本轮落地                                            |
| GAP-2 | `hello.protocol` 传了但没人校验；`capabilities` 字段不存在       | 版本不兼容表现为"连上了什么都不发生"（X4） | §5.2 / §5.3                                   | 本轮落地（协议侧），接线随三端改造                  |
| GAP-3 | `error` 帧没有 `retryAfterMs`                                    | 限流只能盲退避                             | §12.2 E2                                      | 本轮落地                                            |
| GAP-4 | host 不做 `cmdId` 去重                                           | 超时重发 = `cmd.send_prompt` 执行两次      | §10.2 I2–I3                                   | 协议侧提供纯函数；host 接线待排                     |
| GAP-5 | 没有 `ev.host_info`：限额/能力/缺哪些服务全靠各端自己猜          | 同一个"支持"在手机上有三种表现             | §13.2                                         | 规划中（需 client 同步，`wire-surface` 双向闸会拦） |
| GAP-6 | v1 无前向保密、无重放窗口                                        | PSK 泄露可解全部历史                       | §7.6 v2                                       | 规划中                                              |
| GAP-7 | 协议层没有"重复键"策略的声明                                     | 两端对同一帧可能解析出不同值               | §4.3.2                                        | 本轮落地（声明为 last-wins）                        |
| GAP-8 | 附件条数/字节上限在三端各写一遍，靠 `wire-surface` 逐处比对钉住  | 仍是一次正则比对，不是类型级共享           | §11.1                                         | 规划中（协议导出常量 + 闸门改引用）                 |
| GAP-9 | `dshr:` 未按 RFC 7595 注册                                       | 别人无法判断 scheme 归属                   | §6.1.4                                        | 不做（记为取舍）                                    |

## 附录 E · 测试向量与对拍

| 层次          | 判据                                                       | 守住什么                                                      |
| ------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| 协议包单测    | `dsh-remote-protocol/tests/**`                             | 每条 schema 边界、构造器约束、KDF/nonce/记录                  |
| golden vector | `e2e/fixtures/wire-vectors.json` + `e2e/protocol.test.mjs` | 字节级契约（向量由**客户端实现**生成）                        |
| 现跑对拍      | `e2e/mp-crypto.test.mjs`                                   | 两侧当场互解；篡改/错钥两侧一致拒绝                           |
| 面一致性      | `e2e/wire-surface.test.mjs`                                | client 引用的每个类型协议层都有；**且**协议层每个类型都被引用 |
| 帧预算        | `e2e/frame-budget.test.mjs`                                | 真实 `seal()` 下最坏帧仍在中继预算内                          |
| 端到端        | `e2e/run.mjs`（本地全链路）、`e2e/live-e2e.mjs`（真链路）  | 三端协同                                                      |

**变异验证纪律**（本项目的一条硬规则）：每条新判据 MUST 做一次变异，
且变异 MUST 作用在**被测的那段逻辑上**且**能编译**。
"改了源码没重新 build、判据却全绿"测的是上一个产物——
这在历史上真的发生过。

## 附录 F · 规范变更记录

| 版本  | 日期       | 变更                                                                                                                                                                                                                     |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0.0 | 2026-10-07 | 首版。收录 B/F/T 三族冻结契约，补齐五层规范：版本与能力协商（V1–V4、C1–C4）、交付语义（顺序/幂等/重放/离线补拉/nonce）、错误模型（含 `retryAfterMs` 与可重试性）、能力与限额上报、演进与兼容策略。附录 D 登记 9 条 GAP。 |
