/**
 * registry — 注册表**不许与 zod 判别联合漂移**。
 *
 * ## 这条判据守的是哪一类故障
 *
 * 注册表存在的理由是替掉"人手抄一份帧名清单"（中继的 `KNOWN_FRAME_NAMES`）。
 * 但它自己也会漂：协议加了帧、注册表忘了加 → 那个帧被判成 `unknown_frame`，
 * 而对端明明在正确地发它；反过来注册表多了一个名字 → 该分支永远不可达。
 *
 * 两种都是**静默**的。所以这里不测"注册表里有这些名字"（那只是抄一遍自己），
 * 而测**注册表与 zod 联合逐项相等**——联合是形状的事实源，注册表是它的投影。
 *
 * 变异验证：
 * - 从 `ENDPOINT_FRAME_NAMES` 里删一个 → 「endpoint 表与联合逐项相等」红；
 * - 加一个不存在的名字 → 同一判据红；
 * - 从 `CAPABILITY_DESCRIPTIONS` 删一条 → 能力描述穷举那条红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endpointFrame, relayFrame } from '../../src/wire/frames.js'
import { cmdPayload, evPayload, parseCmdPayload, parseEvPayload } from '../../src/wire/payloads.js'
import {
  CAPABILITY_DESCRIPTIONS,
  CAPABILITY_IDS,
  CMD_TYPES,
  ENDPOINT_FRAME_TYPES,
  EV_TYPES,
  FRAME_TYPES,
  RELAY_FRAME_TYPES,
  describeCatalog,
  filterCapabilities,
  hasCapability,
  isCmdType,
  isEvType,
  isKnownCapability,
  isKnownFrameType,
  isKnownPayloadType,
} from '../../src/wire/registry.js'

/** 判别联合自己的选项名——形状的事实源，不是人抄的。 */
const unionNames = (schema: { options?: Array<{ shape: { t: { value: string } } }> }): string[] =>
  (schema.options ?? []).map((option) => option.shape.t.value)

test('endpoint 表与 endpointFrame 判别联合逐项相等（漏一个、多一个都红）', () => {
  assert.deepEqual([...ENDPOINT_FRAME_TYPES].sort(), unionNames(endpointFrame).sort())
})

test('relay 表与 relayFrame 判别联合逐项相等：enc / enc-batch 两个方向都有', () => {
  // 这条曾经真的漏过：relay → endpoint 的 union 里含 enc / enc-batch（中继转发密文），
  // 而人抄的那张表只有 8 个控制帧名。合起来 10 个，少一个都是静默的。
  assert.deepEqual([...RELAY_FRAME_TYPES].sort(), unionNames(relayFrame).sort())
  assert.equal(RELAY_FRAME_TYPES.length, 10)
})

test('两个方向的两张表没有互相矛盾的名字（同一 t 在两边含义必须一致）', () => {
  const endpointNames: readonly string[] = ENDPOINT_FRAME_TYPES
  const overlap = RELAY_FRAME_TYPES.filter((name) => endpointNames.includes(name))
  // 允许的重叠只有 enc / enc-batch：它们是"中继转发给对端的载荷载体"，
  // 不是"中继自己产生的控制帧"。任何别的重叠都意味着某个名字被挪用了（F1）。
  assert.deepEqual([...overlap].sort(), ['enc', 'enc-batch'])
})

test('载荷表与两个判别联合逐项相等；FRAME_TYPES 是两张表的并集且没有重复', () => {
  assert.deepEqual([...CMD_TYPES].sort(), unionNames(cmdPayload).sort())
  assert.deepEqual([...EV_TYPES].sort(), unionNames(evPayload).sort())
  // 命令表与事件表不许有交集：同一个 t 既是命令又是事件，分发时必然有一边不可达。
  const evNames: readonly string[] = EV_TYPES
  assert.deepEqual(
    CMD_TYPES.filter((t) => evNames.includes(t)),
    [],
  )
  // FRAME_TYPES 是并集而不是相加：enc / enc-batch 两边都有，18 - 2 = 16。
  assert.equal(FRAME_TYPES.length, new Set(FRAME_TYPES).size)
  assert.equal(FRAME_TYPES.length, new Set([...ENDPOINT_FRAME_TYPES, ...RELAY_FRAME_TYPES]).size)
  assert.equal(FRAME_TYPES.length, 16)
})

test('能力注册表：每个 id 都有说明，且说明不是空的', () => {
  for (const id of CAPABILITY_IDS) {
    const text = CAPABILITY_DESCRIPTIONS[id]
    assert.equal(typeof text, 'string', `能力 ${id} 没有说明`)
    assert.ok(text && text.length > 0, `能力 ${id} 的说明是空串`)
  }
  assert.deepEqual(Object.keys(CAPABILITY_DESCRIPTIONS).sort(), [...CAPABILITY_IDS].sort())
  // 每个 id 都必须长得像能力 id：`drc.` 前缀 + 小写点分段。
  for (const id of CAPABILITY_IDS) {
    assert.match(id, /^drc\.[a-z0-9]+(\.[a-z0-9-]+)*$/)
  }
})

test('isKnownFrameType 只回答"名字在不在"，不回答"形状对不对"', () => {
  // 这是它存在的意义：第 5 步与第 6 步必须分开（规范 §4.3.2）。
  // `hello` 的形状是错的，但它**是**协议里的帧名 → 必须报 true，
  // 否则中继会把"对端发了坏数据"误报成"对端版本不对"。
  assert.equal(isKnownFrameType('hello'), true)
  assert.equal(isKnownFrameType('hello-ok'), true)
  assert.equal(isKnownFrameType('ev.hello'), false)
  assert.equal(isKnownFrameType(''), false)
  assert.equal(isKnownFrameType(undefined), false)
  assert.equal(isKnownFrameType(42), false)
  assert.equal(isKnownFrameType(null), false)
  assert.equal(isKnownFrameType({}), false)
})

test('载荷/命令/事件判定：三个谓词对同一批名字给出互斥的答案', () => {
  for (const t of CMD_TYPES) {
    assert.ok(isKnownPayloadType(t), `${t} 应当是已知载荷名`)
    assert.ok(isCmdType(t), `${t} 应当是命令`)
    assert.equal(isEvType(t), false, `${t} 不应当是事件`)
  }
  for (const t of EV_TYPES) {
    assert.ok(isKnownPayloadType(t), `${t} 应当是已知载荷名`)
    assert.ok(isEvType(t), `${t} 应当是事件`)
    assert.equal(isCmdType(t), false, `${t} 不应当是命令`)
  }
  assert.equal(isKnownPayloadType('cmd.nope'), false)
  assert.equal(isCmdType(undefined), false)
  assert.equal(isEvType('ev.model '), false, '带空白的名字不是合法名字：分发是逐字比较')
})

test('能力过滤：未注册的 id 被丢掉而不是报错（规范 §15.2）', () => {
  const filtered = filterCapabilities(['drc.v1', 'drc.not-real', 'drc.payload.model', '', 42])
  assert.deepEqual(filtered, ['drc.v1', 'drc.payload.model'])
  assert.deepEqual(filterCapabilities(undefined), [])
  assert.deepEqual(filterCapabilities(['x'] as unknown[]), [])
  assert.equal(hasCapability(['drc.host.resync'], 'drc.host.resync'), true)
  assert.equal(hasCapability(['drc.host.resync'], 'drc.host.info'), false)
  assert.equal(hasCapability(undefined, 'drc.v1'), false)
  assert.equal(isKnownCapability('drc.v1'), true)
  assert.equal(isKnownCapability('DRC.V1'), false, '能力 id 逐字比较')
})

test('describeCatalog 打印的是实测值，且与它数的东西一致', () => {
  const catalog = describeCatalog()
  assert.equal(catalog.endpointFrames, ENDPOINT_FRAME_TYPES.length)
  assert.equal(catalog.relayFrames, RELAY_FRAME_TYPES.length)
  assert.equal(catalog.frames, FRAME_TYPES.length)
  assert.equal(catalog.commands, CMD_TYPES.length)
  assert.equal(catalog.events, EV_TYPES.length)
  assert.equal(catalog.payloads, CMD_TYPES.length + EV_TYPES.length)
  assert.equal(catalog.capabilities, CAPABILITY_IDS.length)
  // 抽两条真的能解析的载荷，确保这些名字不是"只在表里"的死字符串
  assert.ok(parseCmdPayload({ t: 'cmd.list_sessions', cmdId: 'c1' }))
  assert.ok(parseEvPayload({ t: 'ev.run_state', state: 'idle' }))
})
