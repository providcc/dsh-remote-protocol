/**
 * idempotency — `cmdId` 去重台账（规范 §10.2）。
 *
 * ## 这条解决的是一个已经存在的故障
 *
 * client 在 12 秒收不到回执就报超时并允许重发（`core/client.js:32` 的
 * `COMMAND_TIMEOUT_MS`），断线重连后也会补发。于是主机可能把**同一条命令执行两次**：
 *
 * - `cmd.send_prompt` 执行两次 → 用户说了一遍，模型回了两遍；
 * - `cmd.resolve_permission` 执行两次 → 第二次落在一个已经关闭的请求上，
 *   表现是"点了没反应"，而它与真正的失败无法区分；
 * - `cmd.interrupt` 执行两次 → 第二次落在一个已经结束的回合上。
 *
 * 更麻烦的是**它是随机的**：快网络下几乎不复现，慢网络或切后台时必现，
 * 于是排错时永远找不到"那次重复发送"是谁发起的。
 *
 * ## 为什么放在协议层而不是主机
 *
 * 两条理由：
 * 1. 这是**载荷契约**（"cmdId 在一个 conversation 内唯一"），不是插件策略；
 * 2. 它必须是**纯函数式**的——时钟从外面注入，于是判据可以用假时钟把窗口边界
 *    一格一格地走一遍，而不必真的等五分钟。这一条对本仓库尤其重要：
 *    凡是"要靠真实等待才能测"的东西，实际上都不会被测。
 *
 * ## 它不是安全边界
 *
 * 去重是**幂等性**机制，不是防重放的安全机制：真正的防重放依赖密封记录的
 * Poly1305 与通道成员校验（规范 §10.3）。台账在内存里，主机重启即清空——
 * 而主机重启本来就会作废全部会话（`resync{[]}`），所以这条边界恰好与安全边界重合。
 */
import { IDEMPOTENCY_CAPACITY, IDEMPOTENCY_WINDOW_MS } from './limits.js'

/** 一次判定的结果。 */
export type IdempotencyDecision =
  /** 第一次见这条 cmdId：照常执行。 */
  | { action: 'execute' }
  /** 见过：MUST NOT 再执行一次，MUST 重发上一次那个 `ev.result`。 */
  | { action: 'replay'; firstSeenAt: number }
  /** 见过，但已经过了窗口：当作新命令执行（窗口是幂等的有效期，不是安全边界）。 */
  | { action: 'expired'; firstSeenAt: number }

interface Entry {
  at: number
}

/**
 * 有界的 `cmdId` 台账。
 *
 * 用**插入序**而不是 Map 的遍历序做淘汰：`Map` 的插入序在重写同一个键时会保留原位，
 * 而"重写过"恰好意味着它是热键——把它按最旧淘汰会在高负载下丢掉热键。
 */
export class IdempotencyLedger {
  private readonly entries = new Map<string, Entry>()
  private readonly windowMs: number
  private readonly capacity: number

  constructor(options: { windowMs?: number; capacity?: number } = {}) {
    this.windowMs = options.windowMs ?? IDEMPOTENCY_WINDOW_MS
    this.capacity = options.capacity ?? IDEMPOTENCY_CAPACITY
    if (!(this.windowMs > 0)) throw new Error(`去重窗口必须是正数，收到 ${String(this.windowMs)}`)
    if (!Number.isInteger(this.capacity) || this.capacity <= 0) {
      throw new Error(`去重容量必须是正整数，收到 ${String(this.capacity)}`)
    }
  }

  /**
   * 问一次，然后**就地记账**。
   *
   * 合成一个方法而不是 `has()` + `add()`：分开的写法里，进程若在两者之间退出
   * （或者调用方忘了调 `add`），命令就会被执行两次——而那正是本模块要防的事。
   */
  admit(cmdId: string, now: number): IdempotencyDecision {
    if (typeof cmdId !== 'string' || cmdId === '') {
      throw new Error('cmdId 必须是非空字符串')
    }
    // 先取旧条目、再 prune：顺序反了的话，`expired` 那一支永远走不到
    // （prune 会先把过期条目删掉），而它恰好是"这条命令上一轮跑过、只是太久了"
    // 与"这条命令从没来过"之间唯一的区别。
    const seen = this.entries.get(cmdId)
    this.prune(now)
    if (seen && now - seen.at < this.windowMs) {
      return { action: 'replay', firstSeenAt: seen.at }
    }
    // 命中一条已过期的：按新的一次记账（让它从现在起重新计时）。
    this.insert(cmdId, now)
    return seen ? { action: 'expired', firstSeenAt: seen.at } : { action: 'execute' }
  }

  /** 只问不记（诊断与判据用）。 */
  has(cmdId: string, now: number): boolean {
    this.prune(now)
    const seen = this.entries.get(cmdId)
    return seen !== undefined && now - seen.at < this.windowMs
  }

  /** 当前台账里的条数。 */
  get size(): number {
    return this.entries.size
  }

  /** 清空（解配对时调用：那条通道的命令 id 不再有意义）。 */
  clear(): void {
    this.entries.clear()
  }

  /** 丢掉窗口外的条目。 */
  prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.windowMs) this.entries.delete(key)
    }
  }

  private insert(cmdId: string, now: number): void {
    this.entries.set(cmdId, { at: now })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}

/**
 * 命令去重的**窗口下界**：必须不小于 client 的最大重试间隔，
 * 否则"重发的那条"落在窗口外，于是它会被执行第二次。
 *
 * 做成一个函数而不是一个常量，是为了让调用方在算窗口时能引用它——
 * 规范 §10.2 I4 要求的是"≥"，而各端的重试间隔不是同一个数。
 */
export function minimumIdempotencyWindow(clientRetryIntervalMs: number): number {
  if (!(clientRetryIntervalMs > 0)) {
    throw new Error(`client 重试间隔必须是正数，收到 ${String(clientRetryIntervalMs)}`)
  }
  return Math.max(IDEMPOTENCY_WINDOW_MS, clientRetryIntervalMs)
}
