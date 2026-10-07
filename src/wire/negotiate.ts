/**
 * negotiate — 版本与能力协商（规范 §5.2 / §5.3）。
 *
 * ## 为什么版本协商不能只是"传了个数字"
 *
 * `hello.protocol` 这个字段从第一天就在线上，但**没有任何一端校验过它**：
 * 中继回 `hello-ok{protocol}`，两端都不看。于是协议不兼容的表现是
 * "连上了、界面正常、什么都不发生"——这是这套协议里最贵的一类故障形态，
 * 因为它没有任何一层会报错。
 *
 * 本模块把规范 §5.2 的 V1–V4 变成一个纯函数：给对端报的版本，得出
 * "能不能继续"以及"不能继续时该怎么跟用户说"。
 *
 * ## 为什么协商**不**用 SemVer
 *
 * 三端发版节奏不同（宿主跟着 DSH 走、中继是单文件产物、小程序要过体验版审核）。
 * 硬性版本对齐会把"某端晚几天升级"变成"全线不可用"。现行策略是**加性演进**
 * （规范 §15.1），版本号只作为能力陈述而不是闸门——所以这里的判定是
 * "对端是否在我能接受的范围内"，而不是"对端是否与我完全相同"。
 */
import { MIN_SUPPORTED_PROTOCOL, PROTOCOL_VERSION } from './frames.js'
import { filterCapabilities, type CapabilityId } from './registry.js'

export { MIN_SUPPORTED_PROTOCOL, PROTOCOL_VERSION }

/** 判定结果。`ok:false` 时 `message` 是**可以直接给用户看**的中文。 */
export type VersionVerdict =
  | { ok: true; version: number; missing: boolean }
  | { ok: false; reason: 'missing' | 'too_old' | 'too_new' | 'invalid'; message: string; peer: unknown }

/**
 * 校验对端报的协议版本（规范 §5.2 V1–V3）。
 *
 * 规则，逐条对应规范：
 * - **V1**：`undefined` 视为 1（既有小程序不传），不算失败，但要如实标成 `missing`；
 * - **V3**：`MIN ≤ peer ≤ own` 才继续；
 * - **V4**：不接受时 MUST 说清楚"是版本问题"，MUST NOT 报成形状非法。
 *
 * `own` / `min` 可注入：判据要用一个"假想的老版本端点"来跑，
 * 而为了让那个测试不必真的发一个旧版的包，把这两个参数开了口子。
 */
export function negotiateProtocol(
  peerProtocol: unknown,
  own: number = PROTOCOL_VERSION,
  min: number = MIN_SUPPORTED_PROTOCOL,
): VersionVerdict {
  if (peerProtocol === undefined || peerProtocol === null) {
    // V1：缺省视为 1。老对端不发这个字段时，行为与今天完全一致。
    return verdictFor(1, own, min, true)
  }
  if (typeof peerProtocol !== 'number' || !Number.isInteger(peerProtocol) || peerProtocol <= 0) {
    return {
      ok: false,
      reason: 'invalid',
      peer: peerProtocol,
      message: `对方报告的协议版本不是正整数（收到 ${JSON.stringify(peerProtocol) ?? 'undefined'}）`,
    }
  }
  return verdictFor(peerProtocol, own, min, false)
}

function verdictFor(peer: number, own: number, min: number, missing: boolean): VersionVerdict {
  if (peer < min) {
    return {
      ok: false,
      reason: 'too_old',
      peer,
      message: `对方协议版本 ${peer} 太旧，本端最低支持 ${min}；请把对端升级后再试`,
    }
  }
  if (peer > own) {
    return {
      ok: false,
      reason: 'too_new',
      peer,
      message: `对方协议版本 ${peer} 比本端新（${own}）；请把本端升级后再试`,
    }
  }
  return { ok: true, version: peer, missing }
}

/**
 * 双向都认识的能力（规范 §5.3 C1）。
 *
 * 为什么要算交集而不是各报各的：能力 id 是**注册表里的字符串**，一个不认识 `drc.host.info`
 * 的对端照样会收到它，然后按"不认识"忽略——那没问题；真正的问题是反过来：
 * 主机宣称了某个只有新客户端才认的能力，而那个客户端把它渲染成了"已支持"。
 * 交集让双方对"我们之间有什么"有同一个答案。
 */
export function sharedCapabilities(mine: readonly CapabilityId[], theirs?: readonly unknown[]): CapabilityId[] {
  const known = new Set<string>(filterCapabilities(theirs))
  return mine.filter((id) => known.has(id))
}

/** 版本自述，用于日志与 `/api/info`。 */
export function describeVersion(): { protocol: number; minProtocol: number } {
  return { protocol: PROTOCOL_VERSION, minProtocol: MIN_SUPPORTED_PROTOCOL }
}
