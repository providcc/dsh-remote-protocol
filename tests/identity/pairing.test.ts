/**
 * 配对 URI 与配对码。
 *
 * 小程序那份解析器（`mp/core/codec.js`）改不了，所以这里的每一条容错分支
 * 都是**它的**行为，不是我们的偏好。`e2e/protocol.test.mjs` 会把同一批输入
 * 喂给两侧并比对结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPairingUri,
  formatPairingToken,
  normalizePairingToken,
  parsePairingUri,
  randomPairingToken,
} from '../../src/identity/pairing.js'
import { generatePsk } from '../../src/crypto/keys.js'

const PSK = generatePsk()

test('构造→解析 往返一致（含内嵌配对码）', () => {
  const uri = buildPairingUri({ server: 'wss://drc.example.com', psk: PSK, hostLabel: 'my-macbook', token: '123456' })
  assert.ok(uri.startsWith('dshr:/p?'))
  assert.deepEqual(parsePairingUri(uri), {
    v: 1,
    server: 'wss://drc.example.com',
    hostLabel: 'my-macbook',
    psk: PSK,
    token: '123456',
  })
})

test('不带 token 时解析结果的 token 是**空字符串**（不是 undefined，两侧深比较才成立）', () => {
  const uri = buildPairingUri({ server: 'ws://127.0.0.1:8787', psk: PSK })
  const info = parsePairingUri(uri)
  assert.ok(info)
  assert.equal(info.token, '')
  assert.equal(info.hostLabel, 'dsh', 'n 缺省必须是 dsh')
  assert.ok(!uri.includes('&t='))
})

test('非 6 位的 t 被丢弃而不是报错', () => {
  for (const bad of ['12', 'abcdef', '1234567', '1234 6', '00000']) {
    const info = parsePairingUri(`dshr:/p?v=1&s=wss://x&psk=${encodeURIComponent(PSK)}&t=${bad}`)
    assert.ok(info)
    assert.equal(info.token, '', `t=${bad} 应该被丢弃`)
  }
})

test('未编码的 base64 `+` 必须能靠重试路径解出来（B8 的核心）', () => {
  // 手写/第三方二维码常见：psk 里直接出现 '+'，按 URLSearchParams 语义会先变成空格。
  const pskWithPlus = 'ab+cd/ef' + 'X'.repeat(16)
  const naive = `dshr:/p?v=1&s=wss://relay.example&psk=${pskWithPlus}&n=host`
  const info = parsePairingUri(naive)
  assert.ok(info, '未编码的 + 必须被第二遍解析救回来')
  assert.equal(info.psk, pskWithPlus)
  // 我们自己生成的二维码永远走 URLSearchParams，因此裸 `+` 必须以 %2B 出现。
  const ours = buildPairingUri({ server: 'wss://relay.example', psk: pskWithPlus, hostLabel: 'host' })
  assert.match(ours, /psk=ab%2Bcd%2Fef/, '生成侧必须百分号编码 + 与 /')
  assert.equal(parsePairingUri(ours)?.psk, pskWithPlus)
})

test('带 `/` 与 `=` 填充的 PSK 往返不变（base64 尾部 = 不能被 query 切分吃掉）', () => {
  // 2026-10-06：原来这里放的是 `'++++===='` —— 那**不是合法 base64**（`=` 最多两个），
  // 解析器现在按字符集拒它，于是这条用例等于拿一个非法输入测"往返不变"。换成两条真的。
  for (const psk of ['ab+/cd==', 'a//+bc==', generatePsk(), generatePsk()]) {
    const uri = buildPairingUri({ server: 'wss://a.b.c/ws', psk })
    assert.equal(parsePairingUri(uri)?.psk, psk)
  }
})

test('server 里带端口与自定义路径都能解', () => {
  for (const server of ['ws://127.0.0.1:8787', 'wss://drc.provid.cc', 'wss://h.example:8443/ws', 'wss://x/y?z=1']) {
    const uri = buildPairingUri({ server, psk: PSK })
    assert.equal(parsePairingUri(uri)?.server, server)
  }
})

test('非法输入一律返回 null（小程序据此弹「无法识别」）', () => {
  const bad: string[] = [
    '',
    '   ',
    'DSHR:/p?v=1&s=wss://x&psk=' + PSK, // 大小写敏感
    ' dshr:/p?v=1&s=wss://x&psk=' + PSK, // 前导空格
    'https://x.example/p?psk=1', // 别的 scheme
    'dshr:/p', // 没有 query
    'dshr:/p?v=1', // 没有 s 和 psk
    'dshr:/p?v=1&s=wss://x', // 缺 psk
    'dshr:/p?v=1&psk=' + PSK, // 缺 s
    'dshr:/p?',
    'dshr:/p?v=1&s=&psk=' + PSK, // s 是空串
    JSON.stringify({ psk: PSK }),
  ]
  for (const text of bad) assert.equal(parsePairingUri(text), null, `应该拒绝：${text}`)
})

test('query 语义细节：只按第一个 = 切、重复键后者覆盖、未知键忽略、非法 % 不抛', () => {
  const base = 'dshr:/p?s=wss://x&psk=' + encodeURIComponent(PSK)
  assert.equal(parsePairingUri(base + '&v=1')?.server, 'wss://x')
  assert.equal(parsePairingUri(base + '&n=a&n=b')?.hostLabel, 'b', '重复键后者覆盖')
  assert.equal(parsePairingUri(base + '&whatever=1')?.psk, PSK, '未知键忽略')
  assert.equal(parsePairingUri(base + '&n=%zz')?.hostLabel, '%zz', '非法百分号序列回退原串')
})

test('参数顺序无关', () => {
  const a = `dshr:/p?psk=${encodeURIComponent(PSK)}&s=wss://x&v=1&n=h&t=654321`
  const b = `dshr:/p?t=654321&n=h&v=1&s=wss://x&psk=${encodeURIComponent(PSK)}`
  assert.deepEqual(parsePairingUri(a), parsePairingUri(b))
})

test('配对码：6 位数字、均匀取值空间、归一化只剔空格与连字符', () => {
  for (let i = 0; i < 300; i++) assert.match(randomPairingToken(), /^\d{6}$/)
  assert.equal(formatPairingToken(7), '000007')
  assert.equal(formatPairingToken(999999.7), '999999')
  assert.equal(normalizePairingToken(' 12-3 4-56 '), '123456')
  assert.equal(normalizePairingToken('12345a6'), '12345a6', '不合法字符不是被剔掉，而是留给上层判失败')
})

test('formatPairingToken：非有限值抛错，不许产出"000NaN"这种配不上的码', () => {
  assert.equal(formatPairingToken(0), '000000')
  assert.equal(formatPairingToken(7), '000007')
  assert.equal(formatPairingToken(999999.7), '999999')
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => formatPairingToken(bad), `配对码不该接受 ${String(bad)}`)
  }
})

test('randomPairingToken 恒为 6 位数字（手输面靠它）', () => {
  for (let i = 0; i < 200; i += 1) assert.match(randomPairingToken(), /^\d{6}$/)
})

// ── 2026-10-06：解析入口的三条收紧（与小程序侧 parsePairingQr 同步）─────────

test('配对 URI：path 必须是 /p、地址必须 ws(s)、psk 必须像 base64', () => {
  const good = `dshr:/p?s=wss://x&psk=${encodeURIComponent(PSK)}`
  assert.ok(parsePairingUri(good), '合法输入必须照收')
  // path：`dshr:/X?…` 原来也收，而文档语法就是 /p
  assert.equal(parsePairingUri(`dshr:/X?s=wss://x&psk=${encodeURIComponent(PSK)}`), null)
  assert.equal(parsePairingUri(`dshr:?s=wss://x&psk=${encodeURIComponent(PSK)}`), null)
  // 地址：http(s) 连不上 WebSocket，与其拿一条必然失败的地址去连
  assert.equal(parsePairingUri(`dshr:/p?s=https://x&psk=${encodeURIComponent(PSK)}`), null)
  // psk 字符集（长度不在这里判：扫码预览与真正连接分两级报错才对得上）
  assert.equal(parsePairingUri(`dshr:/p?s=wss://x&psk=y`), null)
  assert.equal(parsePairingUri(`dshr:/p?s=wss://x&psk=${encodeURIComponent('a b c')}`), null)
})
