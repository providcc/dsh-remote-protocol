/**
 * idempotency — `cmdId` 去重台账，以及它**报告**自己淘汰了谁的那个出口。
 *
 * ## 台账本身
 *
 * 规范 §10.2 I2/I4：窗口 MUST ≥ client 的最大重试间隔，容量 MUST 有上界。
 * 判据守的是"造一条自己收不了的记录"那类错误（无界台账 = 一条长会话就能耗尽内存）。
 *
 * ## `takeEvicted`（2026-10-07 补）
 *
 * 这一族的缺陷形状：台账自己有界，而**并着的**那张表（宿主侧按 `cmdId` 缓存
 * `ev.result` 以便重发重放）不会自动收缩 —— 它调 `has(cmdId)` 只能问自己那一个键。
 * 于是"台账稳在 256、外挂表长到进程寿命"，而每条回执还带载荷。
 *
 * 遍历整张外挂表对齐是 O(n) **每条命令**，而 n 正是要解决的问题。
 * 正确形状是台账**报告**自己淘汰了谁，见 `takeEvicted` 的注释。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IdempotencyLedger } from '../../src/wire/idempotency.js'
import { IDEMPOTENCY_CAPACITY, IDEMPOTENCY_WINDOW_MS } from '../../src/wire/limits.js'

test('台账的默认窗口与容量取自 limits（那个数只能有一个定义点）', () => {
  const ledger = new IdempotencyLedger()
  // 窗口必须 ≥ client 的最大命令重试间隔（12s），否则"重发的那条"落在窗口外
  // —— 于是它会被执行第二次，而去重窗口比超时窗口短等于没有去重。
  assert.ok(IDEMPOTENCY_WINDOW_MS >= 12_000, `窗口 ${IDEMPOTENCY_WINDOW_MS} 小于 client 的 12s 重试间隔`)
  assert.ok(IDEMPOTENCY_CAPACITY > 0)
  for (let i = 0; i < IDEMPOTENCY_CAPACITY + 10; i++) ledger.admit(`c${i}`, i)
  assert.ok(ledger.size <= IDEMPOTENCY_CAPACITY, `台账长到 ${ledger.size}，超过容量上界`)
  ledger.takeEvicted()
})

test('非法构造参数必须当场抛（造一个自己守不住的台账是最贵的错误）', () => {
  assert.throws(() => new IdempotencyLedger({ windowMs: 0 }))
  assert.throws(() => new IdempotencyLedger({ capacity: 0 }))
  assert.throws(() => new IdempotencyLedger({ capacity: 1.5 }))
})

test('三条判定：第一次 execute、窗口内 replay、过窗口 expired', () => {
  const ledger = new IdempotencyLedger({ windowMs: 100, capacity: 10 })
  assert.equal(ledger.admit('a', 0).action, 'execute')
  assert.equal(ledger.admit('a', 50).action, 'replay', '窗口内重发 MUST NOT 再执行一次')
  assert.equal(ledger.admit('a', 500).action, 'expired', '过窗口的当新命令执行（窗口是有效期不是安全边界）')
  ledger.takeEvicted()
})

// ── takeEvicted：让并着的表能跟着收缩（2026-10-07 补）────────────────
//
// 这一族的缺陷形状：台账自己有界，而**并着的**那张表（宿主侧按 cmdId 缓存
// `ev.result` 以便重发重放）不会自动收缩 —— 它调 `has(cmdId)` 只能问自己那一个键。
// 于是"台账稳在 256、外挂表长到进程寿命"，而每条回执还带载荷。
//
// 遍历整张外挂表对齐是 O(n) 每条命令，而 n 正是要解决的问题。正确形状是
// 台账**报告**自己淘汰了谁。

test('容量淘汰：takeEvicted 给出被挤出去的那些键，且取走即清', () => {
  const ledger = new IdempotencyLedger({ windowMs: 1000, capacity: 2 })
  ledger.takeEvicted() // 先清空上一次可能残留的
  ledger.admit('a', 0)
  ledger.admit('b', 1)
  assert.deepEqual(ledger.takeEvicted(), [], '没淘汰时是空数组（不是 undefined），调用方不必判空')
  ledger.admit('c', 2) // 挤掉 a（插入序最旧）
  assert.deepEqual(ledger.takeEvicted(), ['a'], '必须点名被挤出去的那个')
  assert.deepEqual(ledger.takeEvicted(), [], '取走即清：不能重复报同一个键')
})

test('窗口淘汰：过期条目的键也会被报出来（这是台账最大的一路淘汰）', () => {
  const ledger = new IdempotencyLedger({ windowMs: 100, capacity: 100 })
  ledger.admit('a', 0)
  ledger.admit('b', 0)
  ledger.takeEvicted()
  ledger.admit('c', 500) // 这一发会 prune 掉 a 与 b
  const evicted = ledger.takeEvicted()
  assert.ok(evicted.includes('a') && evicted.includes('b'), `窗口淘汰必须报出来，实得 ${JSON.stringify(evicted)}`)
})

test('反向判据：还没到窗口/没被挤出去的键不许被报（否则外挂表会被误删成空）', () => {
  const ledger = new IdempotencyLedger({ windowMs: 1000, capacity: 10 })
  ledger.takeEvicted()
  ledger.admit('keep1', 0)
  ledger.admit('keep2', 0)
  assert.deepEqual(ledger.takeEvicted(), [], '两条都还在台账里，不该报任何键')
  assert.equal(ledger.size, 2)
  // 再看一眼：has() 也不该顺手把活着的键报成被淘汰
  assert.equal(ledger.has('keep1', 10), true)
  assert.deepEqual(ledger.takeEvicted(), [], 'has() 造成的 prune 没有淘汰任何东西，就不该报')
})

test('clear() 也走同一个出口（解配对时调用方要一次拿到全部键）', () => {
  const ledger = new IdempotencyLedger({ windowMs: 1000, capacity: 10 })
  ledger.admit('a', 0)
  ledger.admit('b', 0)
  ledger.takeEvicted()
  ledger.clear()
  assert.deepEqual(ledger.takeEvicted().sort(), ['a', 'b'], 'clear 是结构性删除，同样要报')
  assert.equal(ledger.size, 0)
  assert.deepEqual(ledger.takeEvicted(), [])
})

test('重发（replay）不产生任何淘汰报告', () => {
  // replay 是纯读路径：它会让 `prune` 跑一次，但如果没真的淘汰谁，
  // 就不该让调用方以为有键要删（否则一条热键会被误删，而那正是去重失效的形状）。
  const ledger = new IdempotencyLedger({ windowMs: 1000, capacity: 10 })
  ledger.admit('a', 0)
  ledger.takeEvicted()
  assert.equal(ledger.admit('a', 10).action, 'replay')
  assert.deepEqual(ledger.takeEvicted(), [])
})
