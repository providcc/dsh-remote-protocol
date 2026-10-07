/**
 * classify — 帧的**分级判定**（规范 §4.3.2 的七步，加上两条配对特例）。
 *
 * ## 为什么把它从中继里搬回协议层
 *
 * 中继的入站管线（`dsh-remote-server/src/server.ts` 的 `ws.on('message')`）此前是：
 * 自己 `JSON.parse`、手抄一份帧名清单、自己分"名字不认识/名字对但形状坏"、
 * 手写 `ciphertextsAreBase64`，再加上两条配对特例。那份清单是**类型受约束的**
 * （`Set<EndpointFrame['t'] | RelayFrame['t']>`，拼错一个字母编译不过），
 * 但"**删掉或改名**一个帧"不会让它变红——那个帧会悄悄从
 * `unknown_frame` 挪到 `bad_frame`，或者反过来，排错时读到的信息整个变味。
 *
 * 更要命的是**七步的分流是隐式的**：没有一条判据说"第 5 步与第 6 步必须分开"，
 * 而这条纪律的价值只在真出问题的时候才体现（规范 §4.3.2）。
 *
 * 本模块把七步变成一个返回值：调用方只剩"照着 reason 发对应的 error"，策略不再散落。
 * **2026-10-07 起中继已接上**（`classifyEndpointFrameText`）。
 *
 * ## 判定结果与错误码的对应（调用方 MUST 照此映射）
 *
 * | reason | 错误码 |
 * |---|---|
 * | `not_object` / `no_frame_type` | `bad_json` |
 * | `unknown_frame` | `unknown_frame` |
 * | `bad_frame` | `bad_frame` |
 * | `bad_ciphertext` | `bad_frame` |
 * | `bad_pair_claim` | `pair-fail{invalid_or_expired}` |
 * | `bad_pair_begin` | `bad_pair` |
 */
import {
  base64Text,
  pairBeginFrame,
  pairClaimFrame,
  parseEndpointFrame,
  parseRelayFrame,
  type EndpointFrame,
  type RelayFrame,
} from './frames.js'
import { isKnownFrameType } from './registry.js'

/** 判定失败的原因。 */
export type FrameVerdictReason =
  | 'not_object'
  | 'no_frame_type'
  | 'unknown_frame'
  | 'bad_frame'
  | 'bad_ciphertext'
  | 'bad_pair_claim'
  | 'bad_pair_begin'

/** endpoint → relay 的判定结果。 */
export type EndpointFrameVerdict =
  { ok: true; frame: EndpointFrame } | { ok: false; reason: FrameVerdictReason; frameType?: string; detail?: string }

/** relay → endpoint 的判定结果。 */
export type RelayFrameVerdict =
  { ok: true; frame: RelayFrame } | { ok: false; reason: FrameVerdictReason; frameType?: string }

function frameTypeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const t = (value as { t?: unknown }).t
  return typeof t === 'string' ? t : undefined
}

/** 密文的字符集预检（`enc` / `enc-batch`）。中继唯一会碰载荷内容的地方，只碰字符集。 */
export function ciphertextsAreBase64(frame: { t: string }): boolean {
  const anyFrame = frame as { ciphertext?: unknown; items?: Array<{ ciphertext?: unknown }> }
  const list = Array.isArray(anyFrame.items) ? anyFrame.items : [anyFrame]
  return list.every((item) => typeof item?.ciphertext === 'string' && base64Text.safeParse(item.ciphertext).success)
}

/**
 * 中继侧：判定一帧 endpoint 来帧。
 *
 * 两条配对特例保留在这里（规范 §6.2）：`pair-begin-client` 的形状错误 MUST 回
 * `pair-fail{invalid_or_expired}` 而不是 `bad_frame`——小程序只认那四个 reason 的中文映射，
 * 一个 `error{bad_frame}` 对它就是一句看不懂的话。而 `pair-begin` 的形状错误回 `bad_pair`，
 * 因为那是**主机**的 bug，说给主机听更准确。
 *
 * 两条都在 schema 判定**之前**：它们判的正是"形状为什么不对"。
 */
export function classifyEndpointFrame(value: unknown): EndpointFrameVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not_object' }
  }
  const frameType = frameTypeOf(value)
  if (frameType === undefined) return { ok: false, reason: 'no_frame_type' }

  if (frameType === 'pair-begin-client' && !pairClaimFrame.safeParse(value).success) {
    return { ok: false, reason: 'bad_pair_claim', frameType }
  }
  if (frameType === 'pair-begin' && !pairBeginFrame.safeParse(value).success) {
    return { ok: false, reason: 'bad_pair_begin', frameType }
  }

  const frame = parseEndpointFrame(value)
  if (!frame) {
    // 第 5 步与第 6 步必须分开（规范 §4.3.2）：前者是"对端版本不对"，后者是"对端发了坏数据"。
    return isKnownFrameType(frameType)
      ? { ok: false, reason: 'bad_frame', frameType }
      : { ok: false, reason: 'unknown_frame', frameType }
  }
  if ((frame.t === 'enc' || frame.t === 'enc-batch') && !ciphertextsAreBase64(frame)) {
    return { ok: false, reason: 'bad_ciphertext', frameType }
  }
  return { ok: true, frame }
}

/**
 * endpoint 侧：判定一帧中继来帧。
 *
 * 与 `classifyEndpointFrame` 的两处差别是刻意的：
 * 1. **没有配对特例**——`pair-ready` / `pair-fail` 的形状错误对端点没有更合适的出口；
 * 2. **不查密文字符集**——端点会去解密，MAC 才是真正的判据，提前按字符集拒收
 *    只会把"手机 vendored 的 base64 实现差异"变成一次静默丢帧（历史事故方向相反：
 *    是**中继**提前拒收造成过"手机能发、主机报错"的假故障）。
 */
export function classifyRelayFrame(value: unknown): RelayFrameVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'not_object' }
  }
  const frameType = frameTypeOf(value)
  if (frameType === undefined) return { ok: false, reason: 'no_frame_type' }
  const frame = parseRelayFrame(value)
  if (!frame) {
    return isKnownFrameType(frameType)
      ? { ok: false, reason: 'bad_frame', frameType }
      : { ok: false, reason: 'unknown_frame', frameType }
  }
  return { ok: true, frame }
}

/** JSON 文本 → 判定结果。解析失败与"不是对象"合并成 `not_object`（调用方都回 `bad_json`）。 */
export function classifyEndpointFrameText(text: string): EndpointFrameVerdict {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'not_object' }
  }
  return classifyEndpointFrame(parsed)
}
