/**
 * errors — 错误码的**语义**（规范 §12.2）。
 *
 * ## 为什么错误码旁边要挂一张"可重试性"表
 *
 * 错误码本身只说"发生了什么"，不说"该怎么办"。而端点真正需要的是后者：
 * `rate_limited` 该退避重试，`unknown_session` 该清配对要求重扫，
 * `bad_frame` 该改代码——三者的用户可见表现完全不同。
 *
 * 现状是每个消费方各自推断：中继有一张中文文案表（`CLIENT_ERROR_TEXT`），
 * 插件**只记日志不分支**（`dsh-remote-control/packages/plugin/src/transport/relay.ts:472-479`），
 * 小程序只特判 `unknown_session`（`core/client.js:352`）。三份推断各自漂移，
 * 而且没有一处能回答"这个码到底该怎么办"。
 *
 * 这张表把可重试性变成协议层的事实。中文文案**不在这里**：文案是产品与部署方的责任，
 * 协议层只保证"发出去的是机器可判的码 + 一个可选的重试提示"。
 */
import { errorCodes, type ErrorCode } from './frames.js'

/**
 * 可重试的错误码（规范 §12.2）。
 *
 * 判据只有一条：**原样重发这条请求，有没有可能在下一次成功？**
 *
 * - `rate_limited` / `pair_table_full`：等一会就成功 ✅
 * - `host_unavailable`：主机在宽限期内，回来就成功 ✅
 * - `internal`：中继自己的问题，重试通常能绕过 ✅
 * - 其余（凭据错、会话没了、帧形状坏、版本不兼容）：重发只会再失败一次 ❌
 *
 * `bad_json` / `bad_frame` / `unknown_frame` 特别要说清楚：它们标的是**对端的 bug**。
 * 把它们标成可重试，等于让端点在一条永远不会自愈的连接上无限重试——
 * 而重试是有限额度的，于是它会把额度耗在"重发同一条坏帧"上。
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'rate_limited',
  'pair_table_full',
  'host_unavailable',
  'internal',
])

/** 这个错误码值不值得原样重试。 */
export function isRetryableError(code: unknown): code is ErrorCode {
  return typeof code === 'string' && RETRYABLE.has(code as ErrorCode)
}

/**
 * 哪些码值得带 `retryAfterMs`。
 *
 * 与可重试性不是一回事：`internal` 可重试，但没人知道该等多久——中继自己也不知道
 * 它的故障会持续几秒。带一个编出来的等待时间，比不带更糟（端点会**当真**）。
 */
const WAIT_HINTABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['rate_limited', 'pair_table_full'])

/** 这个错误码适合带一个重试等待提示。 */
export function wantsRetryAfter(code: unknown): boolean {
  return typeof code === 'string' && WAIT_HINTABLE.has(code as ErrorCode)
}

/** 技术描述——给**日志**看的，不是给用户看的。 */
const DESCRIPTIONS: Readonly<Record<ErrorCode, string>> = {
  bad_role: '连接角色不合法',
  bad_token: 'host 出站凭据校验失败',
  need_host: '此刻没有主机在线',
  need_client: '此刻没有客户端在线',
  bad_pair: 'pair-begin 帧形状非法',
  pair_table_full: '待配对表已满',
  unknown_session: '该配对通道不存在或已被回收（客户端据此清配对并要求重扫）',
  not_member: '发送方不是该会话的成员',
  host_unavailable: '会话仍在，但主机此刻离线（宽限期内）',
  bad_frame: '帧名字对但形状不合法',
  bad_json: '不是合法的 JSON 对象',
  unknown_frame: '帧名不在协议注册表里',
  rate_limited: '命中限速配额',
  unsupported_protocol: '对端协议版本不可接受',
  internal: '中继内部错误',
}

/** 错误码的技术描述。未知码返回 `undefined`（不编造）。 */
export function describeErrorCode(code: unknown): string | undefined {
  return typeof code === 'string' ? DESCRIPTIONS[code as ErrorCode] : undefined
}

/** 全部错误码（注册表的转出，供文档与闸门打印实测值）。 */
export const ERROR_CODES: readonly ErrorCode[] = errorCodes
