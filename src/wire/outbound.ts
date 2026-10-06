/**
 * outbound — 出站帧与出站载荷的**构造器**。
 *
 * 为什么要有这个文件（复核 R7、§5.2）：旧实现（以及我第一版新代码）都是在各处
 * 手搓 `{ t:'paired', sessionId, hostId }` 这样的字面量。这有两个后果：
 *
 * 1. 字段名散落在十几个调用点里，改一个就得改全部，而小程序只会**静默地**显示不出来；
 * 2. "禁止出现的字段"这种约束根本没有防线——比如 `ev.keep_awake_state` 与
 *    `ev.session_changed` 按契约**不带** `sessionId`（F11），但拼装模式下
 *    谁都可能顺手加一个，而 zod 默认会把未知键**剥掉**而不是报错，
 *    于是连测试都看不出差别。
 *
 * 这里把每条出站帧/载荷收成一个函数：参数表就是允许出现的字段集合，
 * 没有的参数**类型上不存在**。`outbound.test.mjs` 再对产物断言键集，
 * 这样 F4（必发帧的必填项）、F11（禁止字段）、F3（sessionId 逐字不变）
 * 才从"文档要求"变成"跑一下就红"。
 */
import { MAX_CIPHERTEXT_BYTES, type ErrorCode } from './frames.js'
import {
  type ChoiceOption,
  type EvKeepAwakeState,
  type EvMessageDelta,
  type EvModel,
  type EvPermissionRequest,
  type EvPermissionResolved,
  type EvQuestionRequest,
  type EvQuestionResolved,
  type EvResult,
  type EvRunState,
  type EvSessionChanged,
  type EvTodo,
  type TodoItem,
  type EvRetry,
  type EvCompaction,
  type EvSessionHistory,
  type EvToolEvent,
  type HistoryItem,
  type ModelOption,
  type QuestionItem,
  type SessionSummary,
  PAYLOAD_TYPES,
} from './payloads.js'

// ── 中继 → 端点 的控制面 ─────────────────────────────────────────────

export interface RelayOutbound {
  t: string
  [key: string]: unknown
}

export function helloOkForClient(clientId: string, protocol?: number): RelayOutbound {
  return { t: 'hello-ok', role: 'client', clientId, ...(protocol === undefined ? {} : { protocol }) }
}

export function helloOkForHost(hostId: string, protocol?: number): RelayOutbound {
  return { t: 'hello-ok', role: 'host', hostId, ...(protocol === undefined ? {} : { protocol }) }
}

/** 服务端权威 TTL。**ttlMs 必须是正整数**：主机要靠它改写本地过期时间（旧实现的第一起事故）。 */
export function pairReady(pairingToken: string, ttlMs: number): RelayOutbound {
  // 构造器守自己 schema 的那条约束（2026-10-06 审计）：schema 是 `positive()`，
  // 而这里原来只管把值塞进去 —— 造出一张对侧会静默丢掉的帧，比抛错难查得多。
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`pair-ready 的 ttlMs 必须是正整数，收到 ${String(ttlMs)}`)
  }
  return { t: 'pair-ready', pairingToken, ttlMs }
}

export function paired(sessionId: string, hostId: string): RelayOutbound {
  return { t: 'paired', sessionId, hostId }
}

export function pairFail(reason: 'invalid_or_expired' | 'already_used' | 'host_offline' | 'bad_token'): RelayOutbound {
  return { t: 'pair-fail', reason }
}

/** 发给主机的加入通知必须带 pairingToken（主机按它取 PSK）；发给客户端的不带。 */
export function peerJoinedForHost(sessionId: string, clientId: string, pairingToken: string): RelayOutbound {
  return { t: 'peer-joined', sessionId, clientId, pairingToken }
}

/**
 * `peer-left` 只有一个合法触发：**主机离开**。
 * 参数表里刻意没有"告诉某个客户端别人走了"的形态——那种帧会让别的手机无辜丢配对（F5）。
 */
export function peerLeft(sessionId: string, clientId: string, unpaired?: boolean): RelayOutbound {
  // unpaired 缺省就是「没这个字段」而不是 false：老主机按「没带 = 断线」处理，
  // 显式 false 反而会让它以为这是一次被判定过的断线。
  return { t: 'peer-left', sessionId, clientId, ...(unpaired ? { unpaired: true } : {}) }
}

export function makeError(code: ErrorCode, message?: string): RelayOutbound {
  return { t: 'error', code, ...(message === undefined ? {} : { message }) }
}

export function pong(ts?: number): RelayOutbound {
  return { t: 'pong', ...(ts === undefined ? {} : { ts }) }
}

/** 数据面：`sessionId` 逐字来自入帧或配对结果，这里不做任何加工（F3）。 */
export function encToClient(sessionId: string, seq: number, ciphertext: string): RelayOutbound {
  // 与 schema 同源的守门（2026-10-06 审计）：超过上限的密文会让对侧静默丢帧，
  // 而中继在转发前只按字符集把关、不看长度 —— 现象是"发出去没回音"。
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error(`密文 ${ciphertext.length} 字节超过上限 ${MAX_CIPHERTEXT_BYTES}`)
  }
  return { t: 'enc', sessionId, seq, ciphertext }
}

export function encBatchToClient(sessionId: string, items: Array<{ seq: number; ciphertext: string }>): RelayOutbound {
  if (items.length === 0) throw new Error('enc-batch 至少要带一项')
  for (const item of items) {
    if (item.ciphertext.length > MAX_CIPHERTEXT_BYTES) {
      throw new Error(`密文 ${item.ciphertext.length} 字节超过上限 ${MAX_CIPHERTEXT_BYTES}`)
    }
  }
  return { t: 'enc-batch', sessionId, items }
}

// ── host → client 的数据面载荷 ───────────────────────────────────────

export function sessionChanged(sessions: SessionSummary[], reason?: string): EvSessionChanged {
  return { t: PAYLOAD_TYPES.evSessionChanged, sessions, ...(reason === undefined ? {} : { reason }) }
}

export function messageDelta(args: {
  messageId: string
  delta: string
  sessionId?: string
  part?: number
  role?: 'assistant' | 'user' | 'system'
  done?: boolean
}): EvMessageDelta {
  return { t: PAYLOAD_TYPES.evMessageDelta, ...args }
}

export function toolEvent(args: {
  callId: string
  phase: 'started' | 'args' | 'completed' | 'failed'
  tool?: string
  title?: string
  argsPreview?: string
  resultPreview?: string
  sessionId?: string
}): EvToolEvent {
  return { t: PAYLOAD_TYPES.evToolEvent, ...args }
}

export function permissionRequest(args: {
  requestId: string
  action: string
  options?: ChoiceOption[]
  resource?: string
  reason?: string
  expiresAt?: string
  sessionId?: string
}): EvPermissionRequest {
  return { t: PAYLOAD_TYPES.evPermissionRequest, ...args }
}

/**
 * 收回一张已经不必回答的审批卡（见 `evPermissionResolved` 的注释：桌面与手机同时被问，
 * 谁先答谁算，**输的那一侧要主动收**，不许让它对着一个已关闭的请求继续倒计时、继续可点）。
 */
export function permissionResolved(args: {
  requestId: string
  sessionId?: string
  by?: 'desktop' | 'cancelled'
}): EvPermissionResolved {
  return { t: PAYLOAD_TYPES.evPermissionResolved, ...args }
}

export function questionRequest(args: {
  requestId: string
  questions: QuestionItem[]
  expiresAt?: string
  sessionId?: string
}): EvQuestionRequest {
  return { t: PAYLOAD_TYPES.evQuestionRequest, ...args }
}

/**
 * 收回一张已经不必回答的提问卡（与 `permissionResolved` 同一条理由：两端同时问、
 * 谁先答谁算，输的那一侧要主动收）。
 *
 * 提问这张卡**本来没有任何倒计时**（`ev.question_request` 今天才补上 `expiresAt`），
 * 所以对它来说这一帧不是"提前收卡"，而是唯一一条能让它消失的路径之一。
 */
export function questionResolved(args: {
  requestId: string
  sessionId?: string
  by?: 'desktop' | 'cancelled'
}): EvQuestionResolved {
  return { t: PAYLOAD_TYPES.evQuestionResolved, ...args }
}

export function runState(args: { state: 'running' | 'idle'; detail?: string; sessionId?: string }): EvRunState {
  return { t: PAYLOAD_TYPES.evRunState, ...args }
}

/**
 * 待办清单（全量快照）。内核每次 `todo/write` 都给整份，所以这里也只发整份——
 * 增量（增删改某一条）在协议里没有形状，手机也不需要理解"改了哪条"。
 */
export function todoList(args: { todos: TodoItem[]; sessionId?: string }): EvTodo {
  return { t: PAYLOAD_TYPES.evTodo, ...args }
}

/**
 * 模型重试。attempt/max/reason 三件套是**手机唯一用得上**的（见 payloads 里的注）。
 *
 * 为什么是这个形状：内核 `llm/retry` 的 data 里还有 policyKey 那段策略 JSON，
 * 对用户毫无意义，不出站；手机要拼的是"正在重试 2/5 · TRANSPORT"。
 */
export function retryNotice(args: { sessionId: string; attempt: number; max: number; reason?: string }): EvRetry {
  return { t: PAYLOAD_TYPES.evRetry, ...args }
}

/** 上下文压缩起止。state 三态别合并（failed 与 ended 对用户是两件事）。 */
export function compactionNotice(args: {
  sessionId: string
  state: 'started' | 'ended' | 'failed'
  error?: string
}): EvCompaction {
  return { t: PAYLOAD_TYPES.evCompaction, ...args }
}

/**
 * 防休眠状态：参数表里没有 `sessionId`（F11）。
 * 想按会话区分就得改协议——那需要先改小程序，而它不在本次范围内。
 */
export function keepAwakeState(args: {
  enabled: boolean
  active: boolean
  platform: string
  backend: string
  reason?: string
}): EvKeepAwakeState {
  return { t: PAYLOAD_TYPES.evKeepAwakeState, ...args }
}

/**
 * 当前模型。
 *
 * **`canSwitch` 必须由生产侧显式给出**，不许让手机从 `options` 有没有值去推断：
 * 「内核不能换」与「能换但清单为空」在手机上必须表现不同（置灰 vs 可点），
 * 推断出来的判断在"清单刚好为空"时会静默错成不可切。
 */
export function model(args: {
  sessionId: string
  model: string
  canSwitch: boolean
  provider?: string
  options?: ModelOption[]
  reason?: string
}): EvModel {
  const payload: EvModel = {
    t: PAYLOAD_TYPES.evModel,
    // sessionId 必填：模型是按会话的，没有它 mp 端无法过滤（§9.29.21）。
    sessionId: args.sessionId,
    model: args.model,
    canSwitch: args.canSwitch,
  }
  if (args.provider !== undefined) payload.provider = args.provider
  // 不可切时**不下发**候选：空数组会让"有候选但都不可选"和"没有候选"在手机上一回事。
  if (args.canSwitch && args.options?.length) payload.options = args.options
  if (args.reason !== undefined) payload.reason = args.reason
  return payload
}

export type EvResultExtras = { message?: string; data?: Record<string, unknown> }

export function result(cmdId: string, ok: boolean, extras: EvResultExtras = {}): EvResult {
  const { message, data } = extras
  return {
    t: PAYLOAD_TYPES.evResult,
    cmdId,
    ok,
    ...(message === undefined ? {} : { message }),
    ...(data === undefined ? {} : { data }),
  }
}

/**
 * 一页历史。
 *
 * **只给游标，不给 `hasMore`**：`nextBeforeSeq` 在 = 还有更早的一页，不在 = 到底了。
 * 原来那版是两个字段，于是"说还有、却忘了给游标"能写得出来，而那产出的是一条
 * 过不了自己 schema 的载荷——它只会在手机侧被静默丢弃，表现是「加载更早」点了没反应。
 * 现在这种状态在类型上不存在。
 */
export function sessionHistory(args: {
  sessionId: string
  cmdId: string
  items: HistoryItem[]
  /** 省略即"这是最初的一页"。 */
  nextBeforeSeq?: number
}): EvSessionHistory {
  const { sessionId, cmdId, items, nextBeforeSeq } = args
  return {
    t: PAYLOAD_TYPES.evSessionHistory,
    sessionId,
    cmdId,
    items,
    ...(nextBeforeSeq === undefined ? {} : { nextBeforeSeq }),
  }
}
