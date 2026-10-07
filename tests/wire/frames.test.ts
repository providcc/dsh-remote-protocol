/**
 * 控制面帧的校验边界。
 *
 * 中继是这套系统里唯一"被不可信输入直接打"的进程（任何能连上 443 的 socket 都能发帧），
 * 所以这里的**拒绝**分支比接受分支更重要：每一类畸形形状都要有一条测试，
 * 否则实现里漏掉一种形状就是线上一条没被覆盖的攻击面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CIPHERTEXT_BYTES,
  MAX_RELAY_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  base64Text,
  encBatchFrame,
  errorFrame,
  helloFrame,
  pairBeginFrame,
  pairReadyFrame,
  parseEndpointFrame,
  parseRelayFrame,
  parseRelayFrameText,
  peerJoinedFrame,
} from '../../src/wire/frames.js'

const CIPHER = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='

test('小程序实际会发的三种帧都通过（F2 的形状，一个字段都不能要求它多给）', () => {
  assert.deepEqual(
    parseEndpointFrame({
      t: 'hello',
      role: 'client',
      protocol: PROTOCOL_VERSION,
      clientId: 'mdwx0abc-9k2j1h',
      clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
    })?.t,
    'hello',
  )
  assert.ok(parseEndpointFrame({ t: 'pair-begin-client', pairingToken: '123456' }))
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_a1b2c3d4e5f6', seq: 1, clientId: 'x', ciphertext: CIPHER }))
  // clientId 与 seq 都是可选的（旧 e2e 就不带 clientId）。
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_a1b2c3d4e5f6', ciphertext: CIPHER }))
})

test('hello：role 只认 host/client；token 只有 host 会带；未知 role 被拒', () => {
  assert.ok(parseEndpointFrame({ t: 'hello', role: 'host', token: 't'.repeat(64), hostId: 'ab12cd34' }))
  assert.equal(parseEndpointFrame({ t: 'hello', role: 'mp', clientId: 'x' }), null)
  assert.equal(parseEndpointFrame({ t: 'hello' }), null)
  assert.equal(helloFrame.safeParse({ t: 'hello', role: 'client', clientId: '' }).success, false, '空 clientId 无意义')
  assert.equal(helloFrame.safeParse({ t: 'hello', role: 'client', clientId: 'x'.repeat(200) }).success, false)
})

test('pair-begin 不再携带 psk（D1 的执行点）', () => {
  const ok = parseEndpointFrame({ t: 'pair-begin', pairingToken: '246810', hostLabel: 'bins' })
  assert.ok(ok)
  assert.equal('psk' in ok, false, 'spec 里不存在 psk 字段，带进来也会被剥掉')
  // 也就是说：即便旧主机发 psk，新中继也不会把它存进任何状态——类型上就没有地方放。
  const withPsk = pairBeginFrame.safeParse({ t: 'pair-begin', pairingToken: '246810', psk: CIPHER })
  assert.equal(withPsk.success, true)
  assert.equal('psk' in (withPsk.data as Record<string, unknown>), false)
})

test('配对码必须是 6 位数字；TTL 必须是正整数', () => {
  for (const bad of ['12345', '1234567', 'abcdef', '12345a', '']) {
    assert.equal(pairBeginFrame.safeParse({ t: 'pair-begin', pairingToken: bad }).success, false, bad)
    assert.equal(parseEndpointFrame({ t: 'pair-begin-client', pairingToken: bad }), null, `客户端认领帧必须拒：${bad}`)
  }
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: 0 }).success, false)
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: -1 }).success, false)
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: 1.5 }).success, false)
  assert.equal(pairReadyFrame.safeParse({ t: 'pair-ready', pairingToken: '123456', ttlMs: 180_000 }).success, true)
})

test('ciphertext 分两层把关：形状层只要求非空字符串，字符集层要求标准 base64', () => {
  // 为什么分两层：如果 base64 校验混在 schema 里，中继就没法区分
  // "帧的形状不对（unknown_frame）"与"密文不是合法 base64（bad_frame）"，
  // 而这两个错误码对排错的价值完全不同。
  const base = { t: 'enc', sessionId: 'c_a1b2c3d4e5f6' }
  assert.ok(parseEndpointFrame({ ...base, ciphertext: CIPHER }))
  for (const bad of ['', 'a', '!!!!', 'AAECAwQFBgcICQoLDA0ODw==\n', 'AA AC', 'AAAA-BBB_CCC=', '====']) {
    assert.equal(base64Text.safeParse(bad).success, false, `字符集层必须拒绝这个 ciphertext：${JSON.stringify(bad)}`)
  }
  assert.equal(base64Text.safeParse(CIPHER).success, true)
  // 形状层仍然守得住：缺字段、超长、非字符串。
  assert.equal(parseEndpointFrame({ ...base, ciphertext: '' }), null)
  assert.equal(parseEndpointFrame(base), null)
  assert.equal(parseEndpointFrame({ ...base, ciphertext: 42 }), null)
  // 上限跟着中继预算走（2026-10-06）：所以"超长"要按那个数取，不是按一个过时的 512 KiB。
  assert.equal(parseEndpointFrame({ ...base, ciphertext: 'A'.repeat(MAX_CIPHERTEXT_BYTES + 1) }), null)
})

test('seq 只当元数据：非负整数可以任意起点，负数与小拒', () => {
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: 0, ciphertext: CIPHER }))
  assert.ok(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: 1_000_000, ciphertext: CIPHER }))
  assert.equal(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: -1, ciphertext: CIPHER }), null)
  assert.equal(parseEndpointFrame({ t: 'enc', sessionId: 'c_x1', seq: 1.5, ciphertext: CIPHER }), null)
})

test('enc-batch 的通道 id 只在外层，items 至少一项且每项自带密文（F12）', () => {
  assert.ok(
    parseEndpointFrame({
      t: 'enc-batch',
      sessionId: 'c_a1b2c3d4e5f6',
      items: [{ ciphertext: CIPHER }, { ciphertext: CIPHER, seq: 2 }],
    }),
  )
  assert.equal(encBatchFrame.safeParse({ t: 'enc-batch', sessionId: 'c_x', items: [] }).success, false)
  assert.equal(encBatchFrame.safeParse({ t: 'enc-batch', sessionId: 'c_x', items: [{ nope: 1 }] }).success, false)
  assert.equal(
    encBatchFrame.safeParse({ t: 'enc-batch', items: [{ ciphertext: CIPHER }] }).success,
    false,
    '缺 sessionId 的批量帧小程序无法解，必须拒',
  )
})

test('中继来帧：paired 必须带 sessionId，peer-joined 可以带 pairingToken，error 的 code 是封闭枚举', () => {
  assert.ok(parseRelayFrame({ t: 'paired', sessionId: 'c_a1b2c3d4e5f6', hostId: 'h1' }))
  assert.equal(parseRelayFrame({ t: 'paired', hostId: 'h1' }), null)
  assert.ok(parseRelayFrame({ t: 'peer-joined', sessionId: 'c_1', clientId: 'c1', pairingToken: '123456' }))
  assert.equal(parseRelayFrame({ t: 'peer-joined', sessionId: 'c_1', pairingToken: '12' }), null)
  assert.ok(parseRelayFrame({ t: 'error', code: 'unknown_session', message: '会话不存在' }))
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'wat' }).success, false)
  assert.equal(errorFrame.safeParse({ t: 'error' }).success, false)
  assert.equal(peerJoinedFrame.safeParse({ t: 'peer-joined', sessionId: 'c_1', clientId: '' }).success, false)
})

test('pair-fail 的 reason 只能是小程序有中文映射的那四个（F6）', () => {
  for (const reason of ['invalid_or_expired', 'already_used', 'host_offline', 'bad_token']) {
    assert.equal(parseRelayFrame({ t: 'pair-fail', reason })?.t, 'pair-fail')
  }
  assert.equal(parseRelayFrame({ t: 'pair-fail', reason: 'expired' }), null)
  // `rate_limited` 是**服务端内部**原因：小程序的 translatePairFail 没有这个键，
  // 发出去就是一条英文字面量弹给用户。中继要限速就记日志，线上写 invalid_or_expired。
  assert.equal(parseRelayFrame({ t: 'pair-fail', reason: 'rate_limited' }), null, 'rate_limited 又回到线上了')
})

test('文本解析：非法 JSON、数组、标量、缺 t 全部返回 null 而不抛', () => {
  for (const raw of ['', 'null', '[]', '42', '"hi"', '{', '{"t":}', '{"nope":1}']) {
    assert.equal(parseRelayFrameText(raw), null, raw)
  }
})

test('未知帧名不会被静默接受（中继据此回 unknown_frame）', () => {
  assert.equal(parseEndpointFrame({ t: 'heartbeat', seq: 1 }), null)
  assert.equal(parseRelayFrame({ t: 'keepalive' }), null)
})

test('一条数据面帧的形状立即可被两侧解析（自证往返）', () => {
  const enc = { t: 'enc', sessionId: 'c_a1b2c3d4e5f6', ciphertext: CIPHER, seq: 3, clientId: 'inst-1' }
  assert.deepEqual(parseRelayFrame(enc), enc)
  assert.deepEqual(parseEndpointFrame(enc), enc)
})

test('resync：主机声明它仍持有密钥的会话（复核 R1 的协议入口）', () => {
  assert.ok(parseEndpointFrame({ t: 'resync', sessionIds: [] }), '空清单是合法且有意义的一条')
  assert.ok(parseEndpointFrame({ t: 'resync', sessionIds: ['c_a1b2c3d4e5f6', 'c_000000000000'] }))
  assert.equal(parseEndpointFrame({ t: 'resync' }), null, '缺 sessionIds 无法表达"我还有这些"')
  assert.equal(parseEndpointFrame({ t: 'resync', sessionIds: 'c_a1b2c3d4e5f6' }), null)
  assert.equal(parseEndpointFrame({ t: 'resync', sessionIds: [''] }), null, '空串 id 没有意义')
})

test('错误消息长度有界（一条失控的 message 不该占满内存）', () => {
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'internal', message: 'x'.repeat(600) }).success, false)
})

// ── 帧预算：合法帧必须过得去（2026-10-06 审计）──────────────────────────
//
// 原来这里只有"超长要拒"，没有"合法帧必须过"。于是密文上限 512 KiB 与中继
// 1 MiB 预算、手机 512 KiB 原始附件的三边关系没人对账，真实的用户故障是：
// 手机选一张合法大小的图 → 密文约 930 KiB → **自家 schema 先拒** →
// 中继回 unknown_frame → 用户看到"图片发不出去"。

test('密文上限跟着中继预算走：手机闸门内最大的附件必须过得去', () => {
  // 手机侧 MAX_ATTACH_TOTAL_BYTES = 512 KiB **原始字节**（mp chat.js），
  // base64 胀 4/3 之后再套一层 secretbox 记录（nonce 24 + MAC 16）并整体 base64。
  const rawBytes = 512 * 1024
  const payloadBytes = Math.ceil(rawBytes / 3) * 4
  const recordBytes = payloadBytes + 24 + 16
  const ciphertextBytes = Math.ceil(recordBytes / 3) * 4
  const ciphertext = 'A'.repeat(ciphertextBytes)
  assert.ok(
    parseEndpointFrame({ t: 'enc', sessionId: 'c_a1b2c3d4e5f6', seq: 1, ciphertext }),
    `密文 ${ciphertextBytes} 字节的合法帧被自家 schema 拒了——手机闸门内的附件发不出去`,
  )
  assert.ok(ciphertextBytes + 128 < MAX_RELAY_MESSAGE_BYTES, '这个上界必须留在中继单帧预算之内，否则会以 1009 断连')
  // 再大就该拒：信封加不进去的时候必须由 schema 先说话。
  assert.equal(
    parseEndpointFrame({ t: 'enc', sessionId: 'c_a1b2c3d4e5f6', ciphertext: 'A'.repeat(MAX_CIPHERTEXT_BYTES + 1) }),
    null,
  )
})

test('批量帧有项数上限：不能靠"塞很多项"绕过单帧预算', () => {
  const items = Array.from({ length: 201 }, () => ({ ciphertext: CIPHER }))
  assert.equal(encBatchFrame.safeParse({ t: 'enc-batch', sessionId: 'c_x', items }).success, false)
  assert.ok(encBatchFrame.safeParse({ t: 'enc-batch', sessionId: 'c_x', items: items.slice(0, 200) }).success)
  assert.equal(encBatchFrame.safeParse({ t: 'enc-batch', sessionId: 'c_x', items: [] }).success, false)
})

test('hello 的 clientMeta 与 token 有长度上限：未认证输入不许放大日志', () => {
  const long = 'x'.repeat(400 * 1024)
  assert.equal(
    parseEndpointFrame({ t: 'hello', role: 'client', clientMeta: { platform: long } }),
    null,
    '这两个字段会被中继逐字写进日志，没有上限就是一条未认证的日志放大通路',
  )
  assert.ok(
    parseEndpointFrame({ t: 'hello', role: 'client', clientMeta: { platform: 'wechat-mp', label: '微信小程序' } }),
  )
  assert.equal(parseEndpointFrame({ t: 'hello', role: 'host', token: 'x'.repeat(513) }), null)
  assert.ok(parseEndpointFrame({ t: 'hello', role: 'host', token: 'x'.repeat(512) }))
})

// ── 版本 / 能力 / 重试提示（规范 §5.2、§5.3、§12.2）────────────────────

test('hello / hello-ok 接受 capabilities，长度有上界（hello 在认证之前就能收到）', () => {
  assert.ok(parseEndpointFrame({ t: 'hello', role: 'host', protocol: 1, capabilities: ['drc.v1'] }))
  assert.ok(parseRelayFrame({ t: 'hello-ok', role: 'host', hostId: 'h', protocol: 1, capabilities: ['drc.v1'] }))
  // 老对端不带它：缺省即"只支持基线"，不是"什么都不支持"
  assert.ok(parseEndpointFrame({ t: 'hello', role: 'client', protocol: 1 }))
  assert.equal(parseEndpointFrame({ t: 'hello', role: 'host', capabilities: 'drc.v1' }), null)
  assert.equal(parseEndpointFrame({ t: 'hello', role: 'host', capabilities: ['x'.repeat(65)] }), null)
  assert.equal(parseEndpointFrame({ t: 'hello', role: 'host', capabilities: Array(65).fill('drc.v1') }), null)
  assert.ok(parseEndpointFrame({ t: 'hello', role: 'host', capabilities: Array(64).fill('drc.v1') }))
})

test('error 带 retryAfterMs：正整数与上界都要守（它是端点算退避的唯一依据）', () => {
  assert.ok(errorFrame.safeParse({ t: 'error', code: 'rate_limited', message: '太频繁', retryAfterMs: 1500 }).success)
  assert.ok(errorFrame.safeParse({ t: 'error', code: 'internal' }).success, '缺省合法：不是所有码都知道该等多久')
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'rate_limited', retryAfterMs: 0 }).success, false)
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'rate_limited', retryAfterMs: -1 }).success, false)
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'rate_limited', retryAfterMs: 1.5 }).success, false)
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'rate_limited', retryAfterMs: 300_001 }).success, false)
})

test('unsupported_protocol 在错误码枚举里，且只有它是"版本问题"的码', () => {
  assert.ok(errorFrame.safeParse({ t: 'error', code: 'unsupported_protocol', message: '版本太旧' }).success)
  // 它不能替掉任何一个既有码：删一个会让中继的 ErrorCode 联合少一项，直接编译不过
  for (const code of [
    'bad_token',
    'need_host',
    'need_client',
    'bad_pair',
    'pair_table_full',
    'unknown_session',
    'not_member',
    'host_unavailable',
    'bad_frame',
    'rate_limited',
    'bad_json',
    'unknown_frame',
    'internal',
  ]) {
    assert.ok(errorFrame.safeParse({ t: 'error', code }).success, `${code} 不能被删`)
  }
  assert.equal(errorFrame.safeParse({ t: 'error', code: 'version_too_old' }).success, false)
})

test('预算常量仍然从 frames 转出（下游从 dsh-remote-wire/frames 引它们）', () => {
  assert.ok(MAX_CIPHERTEXT_BYTES < MAX_RELAY_MESSAGE_BYTES)
  assert.equal(PROTOCOL_VERSION, 1)
})
