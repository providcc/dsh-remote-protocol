/**
 * negotiate / errors / idempotency —— 规范 §5.2、§12.2、§10.2 的判据。
 *
 * 这三样都是"协议里此前没有、而它们的缺席各自对应一种说不出来的故障"的东西：
 * 版本不被校验 → 不兼容表现为"连上了什么都不发生"；
 * 错误码不带可重试性 → 端点要么盲重试要么盲放弃；
 * `cmdId` 不去重 → 超时重发让用户说一遍、模型回两遍。
 *
 * 时钟一律注入，所以"五分钟窗口"是用假时钟一格格走过去的，不靠真的等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MIN_SUPPORTED_PROTOCOL,
  PROTOCOL_VERSION,
  describeVersion,
  negotiateProtocol,
  sharedCapabilities,
} from '../../src/wire/negotiate.js'
import { ERROR_CODES, describeErrorCode, isRetryableError, wantsRetryAfter } from '../../src/wire/errors.js'
import { IdempotencyLedger, minimumIdempotencyWindow } from '../../src/wire/idempotency.js'
import { IDEMPOTENCY_WINDOW_MS } from '../../src/wire/limits.js'
import type { CapabilityId } from '../../src/wire/registry.js'

// ── §5.2 版本协商 ────────────────────────────────────────────────────

test('对端不报版本 = 1（老小程序就是不发这个字段），且必须标成 missing', () => {
  const verdict = negotiateProtocol(undefined)
  assert.equal(verdict.ok, true)
  assert.ok(verdict.ok && verdict.version === 1 && verdict.missing)
  assert.equal(negotiateProtocol(null).ok, true)
})

test('版本落在 [最低, 自身] 之内就继续；之外 MUST 说清楚是版本问题而不是形状问题', () => {
  assert.equal(negotiateProtocol(PROTOCOL_VERSION).ok, true)
  assert.equal(negotiateProtocol(MIN_SUPPORTED_PROTOCOL).ok, true)

  const tooNew = negotiateProtocol(PROTOCOL_VERSION + 1)
  assert.ok(!tooNew.ok && tooNew.reason === 'too_new')
  assert.match(tooNew.message, /比本端新/)

  // "太旧"只有在本端抬高 min 时才可能出现——本协议最低版本就是 1，
  // 而合法版本号是正整数，所以默认配置下这一档是**不可达**的。
  // 这不是漏测：它正是那条注入参数存在的理由。
  const tooOld = negotiateProtocol(1, 3, 2)
  assert.ok(!tooOld.ok && tooOld.reason === 'too_old')
  assert.match(tooOld.message, /太旧/)
  assert.match(tooOld.message, /2/, '消息里要带本端最低支持的版本')

  for (const bad of [0, -1, 1.5, '1', {} as never, NaN]) {
    const verdict = negotiateProtocol(bad)
    assert.ok(!verdict.ok, `${String(bad)} 不该被接受`)
    assert.ok(!verdict.ok && verdict.reason === 'invalid', `${String(bad)} 应当是 invalid`)
  }
})

test('min/own 可注入：判据能跑一个"假想的老端点"而不必真的发一个旧包', () => {
  const asOld = negotiateProtocol(2, 3, 2)
  assert.equal(asOld.ok, true)
  const rejectNewerSelf = negotiateProtocol(2, 1, 1)
  assert.ok(!rejectNewerSelf.ok && rejectNewerSelf.reason === 'too_new')
  // min 高于 1 时，缺省的 1 也必须被拒——否则"不报版本"就成了绕过检查的后门
  const missingTooOld = negotiateProtocol(undefined, 3, 2)
  assert.ok(!missingTooOld.ok && missingTooOld.reason === 'too_old')
})

test('能力取交集：双方对"我们之间有什么"必须是同一个答案', () => {
  const mine: CapabilityId[] = ['drc.v1', 'drc.host.resync', 'drc.host.info']
  assert.deepEqual(sharedCapabilities(mine, ['drc.v1', 'drc.host.info']), ['drc.v1', 'drc.host.info'])
  assert.deepEqual(sharedCapabilities(mine, ['drc.v1', 'drc.nope']), ['drc.v1'])
  assert.deepEqual(sharedCapabilities(mine, undefined), [])
})

test('describeVersion 报的是本端常量，不是手写的数字', () => {
  assert.deepEqual(describeVersion(), { protocol: PROTOCOL_VERSION, minProtocol: MIN_SUPPORTED_PROTOCOL })
})

// ── §12.2 错误语义 ───────────────────────────────────────────────────

test('可重试性：判据只有一条——原样重发有没有可能下一次成功', () => {
  for (const code of ['rate_limited', 'pair_table_full', 'host_unavailable', 'internal'] as const) {
    assert.equal(isRetryableError(code), true, `${code} 应当可重试`)
  }
  // 特别说清楚这三个：它们标的是**对端的 bug**。标成可重试等于让端点在一条
  // 永远不会自愈的连接上重试，而重试额度会被耗在重发同一条坏帧上。
  for (const code of ['bad_frame', 'bad_json', 'unknown_frame'] as const) {
    assert.equal(isRetryableError(code), false, `${code} 是对端的 bug，重试没有意义`)
  }
  // 这一条是安全语义：客户端见到它会清配对要求重扫，标成可重试等于建议它别清。
  assert.equal(isRetryableError('unknown_session'), false)
  assert.equal(isRetryableError('unsupported_protocol'), false, '版本不兼容只能升级，重试一万次也一样')
  assert.equal(isRetryableError('nope'), false)
  assert.equal(isRetryableError(undefined), false)
})

test('等待提示只给"等多久就好"的码：给 internal 编一个等待时间比不给更糟', () => {
  assert.equal(wantsRetryAfter('rate_limited'), true)
  assert.equal(wantsRetryAfter('pair_table_full'), true)
  assert.equal(wantsRetryAfter('internal'), false, '中继自己也不知道故障会持续几秒')
  assert.equal(wantsRetryAfter('bad_frame'), false)
})

test('每个错误码都有一句技术描述；未知码返回 undefined 而不是编一句', () => {
  for (const code of ERROR_CODES) {
    const text = describeErrorCode(code)
    assert.equal(typeof text, 'string', `错误码 ${code} 没有描述`)
    assert.ok(text && text.length > 0)
  }
  assert.equal(describeErrorCode('不存在的码'), undefined)
  assert.equal(describeErrorCode(undefined), undefined)
})

// ── §10.2 幂等 ───────────────────────────────────────────────────────

test('同一条 cmdId 在窗口内只能被执行一次，第二次拿到的是第一次的时刻', () => {
  const ledger = new IdempotencyLedger({ windowMs: 1000, capacity: 8 })
  const first = ledger.admit('cmd-1', 0)
  assert.deepEqual(first, { action: 'execute' })
  assert.deepEqual(ledger.admit('cmd-1', 999), { action: 'replay', firstSeenAt: 0 })
  assert.deepEqual(ledger.admit('cmd-1', 500), { action: 'replay', firstSeenAt: 0 })
  // 窗口边界：恰好等于窗口长度就算过期（"等了一整个窗口"正是该重试的信号）
  assert.deepEqual(ledger.admit('cmd-1', 1000), { action: 'expired', firstSeenAt: 0 })
  // 过期后重新记账 → 窗口从 1000 重新起算，所以 1001 这一次已经是"见过"
  assert.deepEqual(ledger.admit('cmd-1', 1001), { action: 'replay', firstSeenAt: 1000 })
  assert.deepEqual(ledger.admit('cmd-1', 1999), { action: 'replay', firstSeenAt: 1000 })
  assert.deepEqual(ledger.admit('cmd-1', 2000), { action: 'expired', firstSeenAt: 1000 })
  assert.deepEqual(ledger.admit('cmd-2', 2000), { action: 'execute' }, '不同命令互不影响')
})

test('容量有界：超出时按最旧淘汰，且台账不会无界增长', () => {
  const ledger = new IdempotencyLedger({ windowMs: 10_000, capacity: 3 })
  for (let i = 0; i < 10; i += 1) ledger.admit(`cmd-${i}`, i)
  assert.equal(ledger.size, 3)
  // 最旧的被淘汰了 → 它又被当成新命令
  assert.equal(ledger.admit('cmd-0', 11).action, 'execute')
  assert.equal(ledger.admit('cmd-9', 11).action, 'replay', '最新的还在窗口内')
})

test('窗口外的条目会被 prune 掉，size 只反映窗口内的条数', () => {
  const ledger = new IdempotencyLedger({ windowMs: 100, capacity: 100 })
  ledger.admit('a', 0)
  // 第二条命令进来时就会顺手 prune 掉过期的 'a'（500 - 0 ≥ 100）
  ledger.admit('b', 500)
  assert.equal(ledger.size, 1)
  assert.equal(ledger.has('a', 500), false)
  assert.equal(ledger.has('b', 500), true)
  ledger.prune(599)
  assert.equal(ledger.size, 1, '差一毫秒仍在窗口内：边界是 age >= windowMs')
  ledger.prune(600)
  assert.equal(ledger.size, 0)
  ledger.clear()
  assert.equal(ledger.size, 0)
})

test('构造参数非法即抛：错配的窗口会让去重形同虚设，而那没有任何报错', () => {
  assert.throws(() => new IdempotencyLedger({ windowMs: 0 }), /窗口/)
  assert.throws(() => new IdempotencyLedger({ capacity: 0 }), /容量/)
  assert.throws(() => new IdempotencyLedger({ capacity: 1.5 }), /容量/)
  const ledger = new IdempotencyLedger()
  assert.throws(() => ledger.admit('', 0), /cmdId/)
  assert.throws(() => ledger.admit(undefined as unknown as string, 0), /cmdId/)
})

test('窗口下界 ≥ client 的最大重试间隔（规范 I4：比超时窗口短的窗口等于没有窗口）', () => {
  assert.equal(minimumIdempotencyWindow(12_000), IDEMPOTENCY_WINDOW_MS)
  // client 若把重试间隔调到十分钟，默认窗口就不够了——这条让调用方能算出来。
  assert.equal(minimumIdempotencyWindow(10 * 60 * 1000), 10 * 60 * 1000)
  assert.throws(() => minimumIdempotencyWindow(0), /重试间隔/)
})

test('端到端语义：一个只会"admit 就执行"的主机，重复命令只执行一次', () => {
  // 这条是本模块真正的判据——前面几条都在测数据结构，
  // 而真实需求是"用户超时重发一次，不会让模型回两遍"。
  const ledger = new IdempotencyLedger({ windowMs: 5000 })
  const executed: string[] = []
  const handle = (cmdId: string, now: number): 'executed' | 'deduped' => {
    const decision = ledger.admit(cmdId, now)
    if (decision.action === 'execute') {
      executed.push(cmdId)
      return 'executed'
    }
    return 'deduped'
  }
  assert.equal(handle('p1', 0), 'executed')
  assert.equal(handle('p1', 3000), 'deduped', '超时重发的那条不能再执行一次')
  assert.equal(handle('p1', 3000), 'deduped')
  assert.equal(handle('p2', 3000), 'executed', '不同命令照常执行')
  assert.deepEqual(executed, ['p1', 'p2'])
})
