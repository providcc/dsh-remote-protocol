/**
 * frames — 控制面（明文）帧。
 *
 * 这些帧是**中继唯一读得懂的东西**：它按 `t` 与几个标识字段做路由，
 * `ciphertext` 对它是不透明字符串（结构性零知识，docs/DESIGN.md §5.2）。
 *
 * 帧名冻结（F1）：`hello` `hello-ok` `pair-begin` `pair-ready` `pair-begin-client`
 * `paired` `pair-fail` `peer-joined` `peer-left` `enc` `enc-batch` `ping` `pong` `error`。
 * 新增名字是安全的（小程序的 `_onFrame` 把不认识的 `t` 落进 `default` 静默忽略）；
 * **挪用既有名字的语义不是**——比如把心跳响应叫 `peer-left`，
 * 小程序会每收到一次就丢一次配对。
 *
 * 与旧实现的三处结构差异（都不影响小程序，取证 docs/DESIGN.md §4、§8）：
 *
 * - **D5：`auth`/`auth-ok`/`auth-fail` 三帧并成一条 `hello` 注册路径。**
 *   旧的中继里，host 用 `auth`、client 用 `hello` 做同一件事（登记身份、拿回权威 id），
 *   失败面一个是 `auth-fail{reason}` 一个是 `error{code}`。合并后 host 发
 *   `hello{role:'host', token}`，失败统一 `error{code:'bad_token'}`。
 *   小程序仍只发它那一套（F2 的三种帧一个字节都没动）。
 * - **D1：`pair-begin` 不再携带 `psk`。** PSK 只留在主机本地，中继内存里不再有密钥副本。
 * - 删掉两个从未被使用的声明：`session-list` 帧、`cmd.subscribe` 载荷
 *   （前者中继从未发送/处理，后者的 `sessionIds`/`includeContent` 没有任何效果）。
 */
import { z } from 'zod'
import { MAX_CIPHERTEXT_BYTES, MAX_RELAY_MESSAGE_BYTES } from './limits.js'

/**
 * 帧大小预算住 `limits.ts`（三端共享的数值只有一个来源），这里**必须继续转出**：
 * 中继 `src/config.ts` 从 `dsh-remote-wire/frames` 引 `MAX_RELAY_MESSAGE_BYTES`
 * 当 `DRC_MAX_MSG_BYTES` 的默认值，撤掉这条转出是一个只会在下游编译期爆炸的变更。
 */
export { MAX_CIPHERTEXT_BYTES, MAX_RELAY_MESSAGE_BYTES }

/** 协议版本。小程序恒发 `1`（F2）。 */
export const PROTOCOL_VERSION = 1

/** 本协议能接受的**最低**对端版本（规范 §5.2 V3）。 */
export const MIN_SUPPORTED_PROTOCOL = 1

/** 6 位配对码。位数变了要同时动三处（中继校验、主机生成、小程序归一化），而小程序改不了。 */
export const PAIRING_TOKEN_RE = /^\d{6}$/

/**
 * 帧大小预算（`MAX_RELAY_MESSAGE_BYTES` / `MAX_CIPHERTEXT_BYTES`）的定义在
 * `limits.ts`，本文件只转出——转出的理由见文件顶部的 import 旁注。
 * 那两个数为什么是今天这个值（1 MiB 预算、8 KiB 信封余量）记在 `limits.ts` 里。
 */

const nonEmpty = z.string().min(1)
const pairingToken = z.string().regex(PAIRING_TOKEN_RE)

/**
 * 能力列表（规范 §5.3 C1）。上限是**安全要求**，不是洁癖：
 * `hello` 在认证之前就能收到，一条超长数组会白占内存，而它对未认证的对端毫无价值。
 */
const capabilityList = z.array(z.string().min(1).max(64)).max(64)

/**
 * 密文记录的合法性预检。
 *
 * 为什么必须显式写：`Buffer.from(s,'base64')` 对非法字符是**静默丢弃并继续**，
 * 于是"手机能发、主机报错"这类假故障就没有落点。中继在转发前按标准表校验一次
 * （含 `+` `/` `=`，不含 url-safe 表），错的就直接 `bad_frame` 拒掉——
 * 这也是 D4 之外中继唯一会碰载荷内容的地方，而它碰的只是**字符集**，不是明文。
 */
export const base64Text = z
  .string()
  .min(1)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

const clientMeta = z.object({
  /**
   * 长度上限是**安全要求**，不是洁癖（2026-10-06 审计）：这两个字段会被中继逐字
   * 写进 info 日志，而中继在认证前就收 `hello`。实测单连接 20 帧、每帧 400 KiB 的
   * `platform` → 8.19 MB 日志 / 1.2 秒（journald 按条数限流，不按字节）。给它上界，
   * 加上中继侧对日志值的统一截断，这条放大通路就断了。
   */
  platform: z.string().max(128).optional(),
  label: z.string().max(128).optional(),
})
/** 客户端自报的门面信息（小程序发 `{platform:'wechat-mp', label:'微信小程序'}`）。 */
export type ClientMeta = z.infer<typeof clientMeta>

// ── 端点 → 中继 ─────────────────────────────────────────────────────

/** host 与 client 共用这一条注册帧；`token` 只有 host 会带。 */
export const helloFrame = z.object({
  t: z.literal('hello'),
  role: z.enum(['host', 'client']),
  protocol: z.number().int().positive().optional(),
  /**
   * 本端支持的能力（规范 §5.3）。**可选**：老对端不带，老中继也照旧工作——
   * 缺省按"只支持基线"处理，而不是按"什么都不支持"拒绝。
   */
  capabilities: capabilityList.optional(),
  /** host 的出站认证凭据，与中继的 `DRC_HOST_TOKEN` 定时安全比较。上限防超长串白占内存。 */
  token: z.string().min(1).max(512).optional(),
  hostId: nonEmpty.optional(),
  label: z.string().max(128).optional(),
  /** 安装 id，弱随机、非秘密；缺省时由中继分配。上限防一条超长字符串白占内存。 */
  clientId: z.string().min(1).max(128).optional(),
  clientMeta: clientMeta.optional(),
})

/** 主机发布一次性配对码。**没有 psk 字段**——这是 D1 的执行点。 */
export const pairBeginFrame = z.object({
  t: z.literal('pair-begin'),
  pairingToken,
})

/** 客户端认领配对码。小程序从不提交 PSK。 */
export const pairClaimFrame = z.object({
  t: z.literal('pair-begin-client'),
  pairingToken,
})

export const encFrame = z.object({
  t: z.literal('enc'),
  /** 配对通道 id（`c_xxx`），不是 DSH 会话 id（F3）。 */
  sessionId: nonEmpty,
  /** 元数据而已：不得校验单调（F13），host→client 方向由中继重新编号。 */
  seq: z.number().int().nonnegative().optional(),
  clientId: z.string().min(1).max(128).optional(),
  /**
   * 这里只要求"非空字符串"，**字符集合不合法由 `base64Text` 单独把关**。
   * 故意分两层：混在 schema 里，中继就没法区分"形状不对（unknown_frame）"与
   * "密文不是合法 base64（bad_frame）"，而这两个错误码对排错的价值完全不同。
   */
  ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_BYTES),
})

export const encBatchFrame = z.object({
  t: z.literal('enc-batch'),
  /** 通道 id 只在外层；小程序逐项解密时复用它。 */
  sessionId: nonEmpty,
  items: z
    .array(
      z.object({
        seq: z.number().int().nonnegative().optional(),
        ciphertext: z.string().min(1).max(MAX_CIPHERTEXT_BYTES),
      }),
    )
    .min(1)
    /**
     * 项数上限（2026-10-06 审计）：没有上限时一条批量帧可以塞进任意多项，
     * 中继要么在 WS 层按 maxPayload 拒掉、要么先吃满内存再拒。
     * 取 200：单帧总量仍由中继的 maxPayload 兜底（每项最小也有 nonce+MAC+JSON 开销），
     * 这个数只是"别让 items 本身变成无界的"。
     */
    .max(200),
})

/** 显式退出某个会话（D3 之后会话会长存，需要一条主动退出的路）。 */
export const sessionLeaveFrame = z.object({
  t: z.literal('session-leave'),
  sessionId: nonEmpty,
})

export const pingFrame = z.object({ t: z.literal('ping'), ts: z.number().optional() })

/**
 * 主机声明"我此刻仍持有密钥的会话有哪些"。
 *
 * 为什么必须有这条（复核 R1）：D3/D6 让会话跨断连存活之后，出现了旧实现没有的
 * 死角——**主机进程重启**（PSK 随之消失）而中继不知道，于是它继续把手机发来的
 * 密文转发给一个解不开的主机；手机既收不到回复、也收不到 `unknown_session`，
 * 表现是"永远转圈且没有任何提示"。中继自己的表命中与否并不能代表主机是否还认得这个会话。
 *
 * 语义：主机鉴权成功后立刻发一条 `resync`，列出它还持有的 convId。
 * 中继把该主机名下**没被列出**的会话删掉，但**不**向客户端发 `peer-left`——
 * 那在小程序里会翻成一条英文 toast（没有映射），而是让客户端下一次用旧 convId
 * 发帧时自然撞上 `unknown_session`，从而得到中文的"会话已失效，请重新配对"。
 */
export const resyncFrame = z.object({
  t: z.literal('resync'),
  sessionIds: z.array(nonEmpty).max(2000),
})

// 刻意不提供"逐条确认会话还在"的帧：resync 一次就够，
// 多一个入口只会多一类"两条路说法不一致"的故障。

/** 端点可能发给中继的一切。 */
export const endpointFrame = z.discriminatedUnion('t', [
  helloFrame,
  pairBeginFrame,
  pairClaimFrame,
  resyncFrame,

  encFrame,
  encBatchFrame,
  sessionLeaveFrame,
  pingFrame,
])
export type EndpointFrame = z.infer<typeof endpointFrame>

// ── 中继 → 端点 ─────────────────────────────────────────────────────

export const helloOkFrame = z.object({
  t: z.literal('hello-ok'),
  role: z.enum(['host', 'client']),
  /** 权威 clientId：小程序会采纳它并覆盖本地安装 id（F2/§3.6）。 */
  clientId: z.string().min(1).max(128).optional(),
  hostId: nonEmpty.optional(),
  protocol: z.number().int().positive().optional(),
  /** 中继自己支持的能力（规范 §5.3）。端点据此知道自己能向它要什么。 */
  capabilities: capabilityList.optional(),
})

/** 服务端权威 TTL。**主机必须据此改写本地过期时间**——这是旧实现的第一起事故。 */
export const pairReadyFrame = z.object({
  t: z.literal('pair-ready'),
  pairingToken,
  /**
   * 服务端权威 TTL。**有上界**（2026-10-07 补）。
   *
   * 为什么"正整数"不够：端点拿它算本地过期时刻（`createdAt + ttlMs`），
   * 而那一步之后会走 `new Date(...).toISOString()` —— Date 的合法范围是
   * ±8.64e15 ms，一个 `1e17` 的 TTL 让 `toISOString` 抛 `RangeError`。
   *
   * 症状特别贵：那一抛发生在宿主侧**构造 status.json 快照**的过程中，而
   * `shell/status.ts` 的写盘外面包着一个空 catch（"状态入口不许成为崩溃源"）
   * —— 于是**整个 status.json 从此永久停更**，而 GUI 宿主里那是唯一的排错入口
   * （`carrier` / `relay` / `problems` 全部冻在启动那一版）。
   *
   * 上界取 30 天：真实的配对码 TTL 是秒级到分钟级（中继默认 120 s、
   * 本机线上 180 s），30 天已经宽到不可能是误配。而它离 Date 的上限
   * 仍有 11 个数量级，所以这条约束不会在可见的将来变成障碍。
   */
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(30 * 24 * 3600 * 1000),
})

export const pairedFrame = z.object({
  t: z.literal('paired'),
  /** 小程序把它当 convId 持久化并参与密钥派生：缺了它后面全部解不开（F4/F6）。 */
  sessionId: nonEmpty,
  hostId: nonEmpty,
})

/** 四个 reason 是 UI 分支条件，小程序有逐字的中文映射表（F6）。 */
// reason 的取值集合是**冻结消费面**的一部分（F6）：小程序 `mp/core/client.js:translatePairFail`
// 只认这四个键（invalid_or_expired / already_used / host_offline / bad_token），
// 多一个就把英文字面量弹到用户脸上。中继侧内部原因（rate_limited 之类）
// 要记进日志，落到线上的 reason 必须是这张表里的一个。
export const pairFailFrame = z.object({
  t: z.literal('pair-fail'),
  reason: z.enum(['invalid_or_expired', 'already_used', 'host_offline', 'bad_token']),
  /**
   **是哪一张码失败的**（2026-10-07 补，加性）。
   *
   * ## 为什么必须有它
   *
   * 这个帧原先只有 `reason`，而主机侧的处理是"作废**当前展示的那张**"——
   * 于是它只能拿 `active.pairing` 顶罪。多码并存时那会**作废错的那张**：
   * 屏幕上是码 B（完全有效），用户扫了一张早就过期的码 A → 中继回
   * `invalid_or_expired` → 主机把 B 记进 `spentTokens` 并 forget，再补一张 C。
   *
   * 症状不是"多扫一次码"：B 的 PSK 被丢弃意味着那条配对通道作废，
   * 而这正是文件头引用的那起「取错 PSK 全线解不开」事故的前置条件。
   *
   * ## 兼容
   *
   * **可选**：更老的中继不发它，主机侧必须继续按"当前展示的那张"兜底
   * （`onPairFail` 的注释里写着这条兜底的原因）。发它的是中继、读它的是主机，
   * 同一时刻两端版本必然一致——所以"新主机 + 老中继"才是需要兜底的那一侧。
   */
  pairingToken: z.string().min(1).max(16).optional(),
})

export const peerJoinedFrame = z.object({
  t: z.literal('peer-joined'),
  sessionId: nonEmpty,
  clientId: nonEmpty.optional(),
  /** 发给主机的那一份**必须**带：主机按它取对应的 PSK（多码并存那起事故的根因）。 */
  pairingToken: pairingToken.optional(),
})

/** 对客户端而言，`peer-left` 只有一个合法触发：**主机离开**（D3 把这条写死）。 */
export const peerLeftFrame = z.object({
  t: z.literal('peer-left'),
  sessionId: nonEmpty,
  clientId: nonEmpty,
  /**
   * **这一条是不是「主动解配」**（可选，2026-10-05）。
   *
   * 为什么必须能区分：发给主机的 `peer-left` 有两个触发，现场长得一模一样——
   *   - 手机点了「解除配对」（发 session-leave）：它 `_forgetPairing()` 清了 convId，
   *     **再也不会带这个 convId 回来**。主机留着这条会话就是一条永远清不掉的幽灵。
   *   - 手机 socket 断了（切后台、断网）：D3 要求会话留着，回前台还要用它。
   *
   * 不带这个标记 = 断线（老中继行为，保持 D3）；带 true = 主动解配，主机应当把
   * 会话一并作废，于是 pill 从「手机离线」回到「未配对」（2026-10-05 用户报：
   * 「mp 端解除配对，dsh 端执行的是手机离线」）。
   *
   * 可选是刻意的：老中继不会带这个字段，主机必须仍按「断线」处理，不能假定。
   */
  unpaired: z.boolean().optional(),
})

export const errorCodes = [
  'bad_role',
  'bad_token',
  'need_host',
  'need_client',
  'bad_pair',
  'pair_table_full',
  /** 客户端靠这个字面量决定"清配对并提示重扫"（F5）。 */
  'unknown_session',
  /** D4：发送方不是该会话成员。 */
  'not_member',
  /**
   * 会话还在，但主机此刻不在（宽限期内）。**必须区别于 `unknown_session`**：
   * 客户端见到 `unknown_session` 会丢掉配对并要求重新扫码，而这里只是"这条指令没人接"，
   * 用户重试即可，配对关系不该因此作废（D3/D6）。
   */
  'host_unavailable',
  'bad_frame',
  'rate_limited',
  'bad_json',
  'unknown_frame',
  /**
   * 对端的对端版本落在 `[MIN_SUPPORTED_PROTOCOL, 本端]` 之外（规范 §5.2 V3）。
   *
   * 为什么不复用 `bad_frame`：它是**版本问题**而不是形状问题，而它唯一该触发的
   * 动作是"把版本说清楚"——一句"帧形状非法"会让用户去查一个根本不存在的问题。
   * 加它不破坏任何老实现：老 client 见到不认识的码会走兜底展示（`message || code`），
   * 所以中继 MUST 同时带上一句中文 message（规范 §12.3 E1）。
   */
  'unsupported_protocol',
  'internal',
] as const

export const errorFrame = z.object({
  t: z.literal('error'),
  code: z.enum(errorCodes),
  message: z.string().max(512).optional(),
  /**
   * 多久之后可以再来（毫秒）。借鉴 RFC 9110 的 `Retry-After` 的**毫秒形态**。
   *
   * 只有 `rate_limited` / `pair_table_full` 这类"等一等就好"的码才带它：
   * 端点拿它直接算退避，而没有它时只能盲退——盲退在限速窗口上等于
   * "再多撞几次，每一次都让窗口重新计时"。
   */
  retryAfterMs: z.number().int().positive().max(300_000).optional(),
})
export type ErrorCode = z.infer<typeof errorFrame>['code']

export const pongFrame = z.object({ t: z.literal('pong'), ts: z.number().optional() })

/** 中继可能发给端点的一切。 */
export const relayFrame = z.discriminatedUnion('t', [
  helloOkFrame,
  pairReadyFrame,
  pairedFrame,
  pairFailFrame,
  peerJoinedFrame,
  peerLeftFrame,
  errorFrame,
  pongFrame,
  encFrame,
  encBatchFrame,
])
export type RelayFrame = z.infer<typeof relayFrame>

// ── 解析与构造 ──────────────────────────────────────────────────────

/** 中继解析端点来帧。`t` 认不出 → null（调用方回 `unknown_frame`）。 */
export function parseEndpointFrame(value: unknown): EndpointFrame | null {
  const parsed = endpointFrame.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 端点（主机或小程序）解析中继来帧。 */
export function parseRelayFrame(value: unknown): RelayFrame | null {
  const parsed = relayFrame.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** JSON 文本 → 对象 → 中继来帧；任何一步失败都 null（小程序侧同样静默丢弃非法帧）。 */
export function parseRelayFrameText(raw: string): RelayFrame | null {
  try {
    return parseRelayFrame(JSON.parse(raw))
  } catch {
    return null
  }
}
