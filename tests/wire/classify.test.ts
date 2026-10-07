/**
 * classify — 七步分级判定的判据（规范 §4.3.2）。
 *
 * ## 这条判据存在的理由：中继曾经把第 5 步与第 6 步合成一步
 *
 * 旧中继只看 `typeof t === 'string'`，于是 `{t:'enc'}`（缺 ciphertext）这种
 * "名字对、形状坏"的帧被报成 `unknown_frame`。排错时它读起来是
 * "对端版本不对"——而真相是对端发了一条坏数据。这条误读会把人带去查错方向。
 *
 * 所以判据覆盖的不是"合法帧能过"，而是**每一档错误各自落到哪个 reason**：
 * 那七个 reason 与七个错误码的映射就是这套协议在故障现场唯一的可观测面。
 *
 * 变异验证：把 `unknown_frame` 与 `bad_frame` 两个分支对调 → 第 3 条红；
 * 把配对特例挪到 schema 判定之后 → 第 6、7 条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyEndpointFrame,
  classifyEndpointFrameText,
  classifyRelayFrame,
  ciphertextsAreBase64,
} from '../../src/wire/classify.js'

const enc = { t: 'enc', sessionId: 'c_0123456789ab', ciphertext: 'AAAA' }

test('合法帧原样通过，且拿回来的就是解析后的那一帧', () => {
  const verdict = classifyEndpointFrame(enc)
  assert.equal(verdict.ok, true)
  assert.ok(verdict.ok)
  assert.equal(verdict.frame.t, 'enc')
  assert.equal(classifyEndpointFrame({ t: 'hello', role: 'host', token: 'x' }).ok, true)
  assert.equal(classifyEndpointFrame({ t: 'ping' }).ok, true)
  assert.equal(classifyEndpointFrame({ t: 'resync', sessionIds: [] }).ok, true)
})

test('第 1–4 步：不是对象 / 没有 t，分别落到 not_object 与 no_frame_type（都回 bad_json）', () => {
  for (const value of [null, undefined, 42, 'enc', true, ['enc']]) {
    const verdict = classifyEndpointFrame(value)
    assert.equal(verdict.ok, false)
    assert.ok(!verdict.ok && verdict.reason === 'not_object', `${JSON.stringify(value)} 应当是 not_object`)
  }
  assert.ok(!classifyEndpointFrame({}).ok)
  assert.ok(!classifyEndpointFrame({ t: 42 }).ok)
  assert.ok(!classifyEndpointFrame({ t: '' }).ok)
  const noType = classifyEndpointFrame({ notT: 'enc' })
  assert.ok(!noType.ok && noType.reason === 'no_frame_type')
})

test('第 5 步与第 6 步必须分开：名字不认识 = unknown_frame，名字对但形状坏 = bad_frame', () => {
  // hello-ok 是协议里的帧名，但它是 relay→endpoint 的，端点发它就是 bad_frame。
  const relayOnly = classifyEndpointFrame({ t: 'hello-ok', role: 'client' })
  assert.ok(!relayOnly.ok && relayOnly.reason === 'bad_frame', '协议里存在的名字，形状对不上就是 bad_frame')

  const notInProtocol = classifyEndpointFrame({ t: 'enc-batch-v2', sessionId: 'c_1' })
  assert.ok(!notInProtocol.ok && notInProtocol.reason === 'unknown_frame')

  const badShape = classifyEndpointFrame({ t: 'enc', sessionId: 'c_1' }) // 缺 ciphertext
  assert.ok(!badShape.ok && badShape.reason === 'bad_frame')
  assert.equal(!badShape.ok ? badShape.frameType : undefined, 'enc', '判定里要带上帧名：排错时它是第一条线索')

  // 这一条是本文件的重点：`hello` 的形状是错的，但它**是**协议里的帧名。
  const knownNameWrongShape = classifyEndpointFrame({ t: 'hello', role: 'weird' })
  assert.ok(!knownNameWrongShape.ok && knownNameWrongShape.reason === 'bad_frame')
})

test('第 7 步：密文不是标准 base64 是 bad_ciphertext（与 bad_frame 分开，中继文案不同）', () => {
  const bad = classifyEndpointFrame({ t: 'enc', sessionId: 'c_1', ciphertext: 'not base64!!' })
  assert.ok(!bad.ok && bad.reason === 'bad_ciphertext')
  // url-safe 表（- 与 _）不是标准表：中继按标准表校验，而手机那边解得开——
  // 于是这一档必须在中继就拒掉，不能让它走到主机报一个更含糊的错。
  const urlSafe = classifyEndpointFrame({ t: 'enc', sessionId: 'c_1', ciphertext: 'a-b_' })
  assert.ok(!urlSafe.ok && urlSafe.reason === 'bad_ciphertext')
  assert.equal(classifyEndpointFrame({ t: 'enc', sessionId: 'c_1', ciphertext: 'a+b/' }).ok, true)

  const batch = classifyEndpointFrame({
    t: 'enc-batch',
    sessionId: 'c_1',
    items: [
      { seq: 1, ciphertext: 'AAAA' },
      { seq: 2, ciphertext: 'bad one' },
    ],
  })
  assert.ok(!batch.ok && batch.reason === 'bad_ciphertext', '批量帧里有一项坏，整帧坏')
  assert.equal(ciphertextsAreBase64({ t: 'enc-batch', items: [{ ciphertext: 'AAAA' }] } as never), true)
})

test('配对特例先于 schema：pair-begin-client 形状坏回 bad_pair_claim（小程序只认那四个 reason）', () => {
  const claim = classifyEndpointFrame({ t: 'pair-begin-client', pairingToken: '123' })
  assert.ok(!claim.ok && claim.reason === 'bad_pair_claim')
  assert.equal(classifyEndpointFrame({ t: 'pair-begin-client', pairingToken: '123456' }).ok, true)
})

test('pair-begin 形状坏回 bad_pair_begin（说给主机听更准确）', () => {
  const begin = classifyEndpointFrame({ t: 'pair-begin', pairingToken: 'abcdef' })
  assert.ok(!begin.ok && begin.reason === 'bad_pair_begin')
  assert.equal(classifyEndpointFrame({ t: 'pair-begin', pairingToken: '000001' }).ok, true)
})

test('relay → endpoint 侧：没有配对特例，也不预检密文字符集', () => {
  assert.equal(classifyRelayFrame({ t: 'hello-ok', role: 'client' }).ok, true)
  const unknown = classifyRelayFrame({ t: 'nope' })
  assert.ok(!unknown.ok && unknown.reason === 'unknown_frame')
  const badShape = classifyRelayFrame({ t: 'paired' })
  assert.ok(!badShape.ok && badShape.reason === 'bad_frame')
  const notObject = classifyRelayFrame('x')
  assert.ok(!notObject.ok && notObject.reason === 'not_object')
  // 端点侧不预检字符集：它会去解密，MAC 才是真判据。
  // 提前按字符集拒收只会把"两端 base64 实现差异"变成一次静默丢帧。
  assert.equal(classifyRelayFrame({ t: 'enc', sessionId: 'c_1', ciphertext: 'not base64!!' }).ok, true)
})

test('文本入口：JSON 解析失败与不是对象都折叠成 not_object（调用方都回 bad_json）', () => {
  assert.ok(!classifyEndpointFrameText('{oops').ok)
  assert.equal(classifyEndpointFrameText(JSON.stringify(enc)).ok, true)
  assert.equal(classifyEndpointFrameText(JSON.stringify({ t: 'ping' })).ok, true)
  const parsed = classifyEndpointFrameText(JSON.stringify({ t: 'what' }))
  assert.ok(!parsed.ok && parsed.reason === 'unknown_frame')
})
