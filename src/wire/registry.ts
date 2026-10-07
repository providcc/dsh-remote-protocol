/**
 * registry — 协议注册表：帧名、载荷名、能力 id。
 *
 * ## 为什么要有这个文件
 *
 * 注册表本来是"协议知识"，但它曾经散在三处，每一处都要人肉同步：
 *
 * 1. zod 的两个判别联合（`endpointFrame` / `relayFrame`）——形状的事实源；
 * 2. 中继 `src/server.ts` 里手抄的 `KNOWN_FRAME_NAMES`——**手抄**的一份，用来把
 *    "帧名不认识"（`unknown_frame`）与"名字对、形状坏"（`bad_frame`）分开；
 *    （2026-10-07 已删：中继改 import 本文件的 `FRAME_TYPES` / `isKnownFrameType`。）
 * 3. 伞仓 `e2e/wire-surface.test.mjs` 靠正则从 `payloads.ts` 的**源码文本**里
 *    抽 `'ev.xxx'` / `'cmd.xxx'` 字面量。
 *
 * 三处同步意味着"协议加了帧、中继忘了改"不会编译失败、也不会测试变红，
 * 只是那个新帧在排错时永远收到一句 `unknown_frame`。本文件把 2 与 3 收进来：
 * 中继改 import 即可（删掉那份手抄），伞仓的闸门也能改成比对**导出的常量**
 * 而不是源码文本。
 *
 * ## 编译期保证"这张表与 union 完全一致"
 *
 * 表里多一个名字会怎样？union 解析时那个分支不可达，帧被静默拒收。
 * 表里少一个名字会怎样？那个帧被判成 `unknown_frame`，而对端明明在正确地发它。
 * 两种都是静默的。所以下面用 `_Assert<...>` 把它变成编译错误。
 */
import { PAYLOAD_TYPES, type CmdPayload, type EvPayload } from './payloads.js'
import { errorCodes, type EndpointFrame, type RelayFrame } from './frames.js'

/** 类型层的"不多不少"断言：T 是 true 才编译得过。 */
type _Assert<T extends true> = T

// ── 控制帧名 ─────────────────────────────────────────────────────────

/**
 * endpoint → relay 的全部帧名（规范 §17.1）。
 *
 * 与 `EndpointFrame['t']` 必须完全一致。
 */
const ENDPOINT_FRAME_NAMES = [
  'hello',
  'pair-begin',
  'pair-begin-client',
  'resync',
  'enc',
  'enc-batch',
  'session-leave',
  'ping',
] as const
type _EndpointNamesMatchUnion = _Assert<
  Exclude<EndpointFrame['t'], (typeof ENDPOINT_FRAME_NAMES)[number]> extends never
    ? Exclude<(typeof ENDPOINT_FRAME_NAMES)[number], EndpointFrame['t']> extends never
      ? true
      : false
    : false
>

/**
 * relay → endpoint 的全部帧名（规范 §17.1）。
 *
 * 注意末尾那两条：`enc` / `enc-batch` **两个方向都有**——它们既是端点的出站帧，
 * 也是中继转发给对端的载荷载体。漏掉它们的后果正是下面那个 `_Assert` 报的错：
 * 表与 union 对不上，而人眼扫一遍两个列表根本看不出来（那张表写在文档里、
 * union 写在 zod 里，两处从来没有被机械比过）。
 */
const RELAY_FRAME_NAMES = [
  'hello-ok',
  'pair-ready',
  'paired',
  'pair-fail',
  'peer-joined',
  'peer-left',
  'error',
  'pong',
  'enc',
  'enc-batch',
] as const
type _RelayNamesMatchUnion = _Assert<
  Exclude<RelayFrame['t'], (typeof RELAY_FRAME_NAMES)[number]> extends never
    ? Exclude<(typeof RELAY_FRAME_NAMES)[number], RelayFrame['t']> extends never
      ? true
      : false
    : false
>

/** endpoint → relay 的帧名。 */
export const ENDPOINT_FRAME_TYPES: readonly EndpointFrame['t'][] = ENDPOINT_FRAME_NAMES
/** relay → endpoint 的帧名。 */
export const RELAY_FRAME_TYPES: readonly RelayFrame['t'][] = RELAY_FRAME_NAMES
/**
 * 协议里存在过的全部控制帧名（两个方向的并集）。
 *
 * **去重**：enc / enc-batch 两个方向都有，直接相加会得到 18 个条目、16 个不同名字，
 * 而"注册表里有几条帧"这种问法本身就该按不同名字算——否则文档里的数字会骗人
 * （本项目已经吃过一次这种亏：README 里的"项数"漂了半年，见伞仓 HANDOFF §0.10.6）。
 */
export const FRAME_TYPES: readonly (EndpointFrame['t'] | RelayFrame['t'])[] = [
  ...new Set<EndpointFrame['t'] | RelayFrame['t']>([...ENDPOINT_FRAME_NAMES, ...RELAY_FRAME_NAMES]),
]

const FRAME_TYPE_SET: ReadonlySet<string> = new Set<string>(FRAME_TYPES)

/**
 * 这个名字在协议里存在吗？（规范 §4.3.2 第 5 步）
 *
 * **只回答"名字"，不回答"形状"**——这两个必须分开，它们的错误码不同
 * （`unknown_frame` vs `bad_frame`），而它们对排错的价值完全不同：
 * 前者是"对端版本不对"，后者是"对端发了坏数据"。
 */
export function isKnownFrameType(name: unknown): name is EndpointFrame['t'] | RelayFrame['t'] {
  return typeof name === 'string' && FRAME_TYPE_SET.has(name)
}

// ── 载荷名 ────────────────────────────────────────────────────────────

/** client → host 的全部命令名（规范 §17.2）。 */
export const CMD_TYPES: readonly CmdPayload['t'][] = [
  PAYLOAD_TYPES.cmdSendPrompt,
  PAYLOAD_TYPES.cmdAnswer,
  PAYLOAD_TYPES.cmdResolvePermission,
  PAYLOAD_TYPES.cmdInterrupt,
  PAYLOAD_TYPES.cmdListSessions,
  PAYLOAD_TYPES.cmdKeepAwake,
  PAYLOAD_TYPES.cmdSessionHistory,
  PAYLOAD_TYPES.cmdNewSession,
  PAYLOAD_TYPES.cmdGetPending,
  PAYLOAD_TYPES.cmdArchiveSession,
]
type _CmdNamesMatchUnion = _Assert<
  Exclude<CmdPayload['t'], (typeof CMD_TYPES)[number]> extends never
    ? Exclude<(typeof CMD_TYPES)[number], CmdPayload['t']> extends never
      ? true
      : false
    : false
>

/** host → client 的全部事件名（规范 §17.3）。 */
export const EV_TYPES: readonly EvPayload['t'][] = [
  PAYLOAD_TYPES.evSessionChanged,
  PAYLOAD_TYPES.evMessageDelta,
  PAYLOAD_TYPES.evToolEvent,
  PAYLOAD_TYPES.evPermissionRequest,
  PAYLOAD_TYPES.evPermissionResolved,
  PAYLOAD_TYPES.evQuestionRequest,
  PAYLOAD_TYPES.evQuestionResolved,
  PAYLOAD_TYPES.evRunState,
  PAYLOAD_TYPES.evTodo,
  PAYLOAD_TYPES.evRetry,
  PAYLOAD_TYPES.evCompaction,
  PAYLOAD_TYPES.evKeepAwakeState,
  PAYLOAD_TYPES.evModel,
  PAYLOAD_TYPES.evResult,
  PAYLOAD_TYPES.evSessionHistory,
]
type _EvNamesMatchUnion = _Assert<
  Exclude<EvPayload['t'], (typeof EV_TYPES)[number]> extends never
    ? Exclude<(typeof EV_TYPES)[number], EvPayload['t']> extends never
      ? true
      : false
    : false
>

const PAYLOAD_TYPE_SET: ReadonlySet<string> = new Set<string>([...CMD_TYPES, ...EV_TYPES])

/** 这个 `t` 是协议里存在过的载荷名吗？（命令或事件都算） */
export function isKnownPayloadType(name: unknown): name is CmdPayload['t'] | EvPayload['t'] {
  return typeof name === 'string' && PAYLOAD_TYPE_SET.has(name)
}

/** 这个 `t` 是命令吗？ */
export function isCmdType(name: unknown): name is CmdPayload['t'] {
  return typeof name === 'string' && (CMD_TYPES as readonly string[]).includes(name)
}

/** 这个 `t` 是事件吗？ */
export function isEvType(name: unknown): name is EvPayload['t'] {
  return typeof name === 'string' && (EV_TYPES as readonly string[]).includes(name)
}

// ── 能力 id ───────────────────────────────────────────────────────────

/**
 * 能力注册表（规范 §17.4）。`hello` / `hello-ok` 的 `capabilities` 只能从这里取。
 *
 * 能力的意义是**把"支持/不支持"从形状里解耦出来**：同一个字段，
 * "没有候选"、"不能切"、"这一代内核不支持"在手机上必须是三种不同的表现，
 * 而靠"字段有没有值"去推断必然在边界情形下静默错。
 */
export const CAPABILITY_IDS = [
  'drc.v1',
  'drc.pairing.qr',
  'drc.pairing.token',
  'drc.payload.attachments',
  'drc.payload.history',
  'drc.payload.new-session.workspace',
  'drc.payload.get-pending',
  'drc.payload.keep-awake',
  'drc.payload.archive-session',
  'drc.payload.model',
  'drc.payload.retry-compaction',
  'drc.cmd.idempotency',
  'drc.data.enc-batch',
  'drc.host.resync',
  'drc.host.info',
  'drc.crypto.v2',
] as const

/** 一个能力 id。 */
export type CapabilityId = (typeof CAPABILITY_IDS)[number]

/** 每个能力 id 的人话说明——`describeCatalog()` 与排错日志用它。 */
export const CAPABILITY_DESCRIPTIONS: Readonly<Record<CapabilityId, string>> = {
  'drc.v1': '基线：协议 1、PSK 配对、enc 载荷',
  'drc.pairing.qr': '支持 dshr: 二维码配对',
  'drc.pairing.token': '支持 6 位码单独输入',
  'drc.payload.attachments': '支持 images / files 附件',
  'drc.payload.history': '支持游标分页的历史',
  'drc.payload.new-session.workspace': '支持 cmd.new_session.workspace',
  'drc.payload.get-pending': '支持 cmd.get_pending',
  'drc.payload.keep-awake': '支持防休眠开关',
  'drc.payload.archive-session': '支持 cmd.archive_session（归档/取消归档，不含 stopActivity）',
  'drc.payload.model': '支持 ev.model',
  'drc.payload.retry-compaction': '支持 ev.retry / ev.compaction',
  'drc.cmd.idempotency': '本端按 cmdId 去重（规范 §10.2）',
  'drc.data.enc-batch': '支持批量密文帧',
  'drc.host.resync': '本端鉴权后会发 resync',
  'drc.host.info': '本端会发 ev.host_info',
  'drc.crypto.v2': '支持消息棘轮（规划中，规范 §7.6）',
}

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITY_IDS)

/** 这是注册过的能力 id 吗？未知 id MUST 忽略而不是报错（规范 §15.2）。 */
export function isKnownCapability(id: unknown): id is CapabilityId {
  return typeof id === 'string' && CAPABILITY_SET.has(id)
}

/** 对端声明的能力里，本端**认识**的那些。未知 id 被丢掉。 */
export function filterCapabilities(list: readonly unknown[] | undefined): CapabilityId[] {
  if (!Array.isArray(list)) return []
  return list.filter(isKnownCapability)
}

/** 对端是否声明了某个能力。 */
export function hasCapability(list: readonly unknown[] | undefined, id: CapabilityId): boolean {
  return Array.isArray(list) && list.includes(id)
}

// ── 自述 ─────────────────────────────────────────────────────────────

/** 注册表自述。文档与闸门用它打印实测值，而不是各写一个数字（见 `scripts/report-gates.mjs`）。 */
export function describeCatalog(): {
  endpointFrames: number
  relayFrames: number
  frames: number
  commands: number
  events: number
  payloads: number
  capabilities: number
  errorCodes: number
} {
  return {
    endpointFrames: ENDPOINT_FRAME_TYPES.length,
    relayFrames: RELAY_FRAME_TYPES.length,
    frames: FRAME_TYPES.length,
    commands: CMD_TYPES.length,
    events: EV_TYPES.length,
    payloads: CMD_TYPES.length + EV_TYPES.length,
    capabilities: CAPABILITY_IDS.length,
    errorCodes: errorCodes.length,
  }
}
