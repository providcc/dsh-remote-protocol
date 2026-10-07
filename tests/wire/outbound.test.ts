/**
 * 出站构造器的机械防线（复核 R7 要求"从注释变成跑一下就红"）。
 *
 * 这里守的是三类东西：
 * - **必发帧的必填项**（F4）：hello-ok 对客户端必须带 clientId、paired 必须带 sessionId；
 * - **禁止出现的字段**（F11）：ev.keep_awake_state / ev.session_changed 不许带 sessionId；
 * - **两条 peer-joined 路径的字段集差异**（旧事故）：给主机的必须带 pairingToken，给客户端的必须不带。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CIPHERTEXT_BYTES,
  PROTOCOL_VERSION,
  parseEndpointFrame,
  parseRelayFrame,
  relayFrame,
} from '../../src/wire/frames.js'
import { parseEvPayload } from '../../src/wire/payloads.js'
import type { CapabilityId } from '../../src/wire/registry.js'
import {
  encBatchToClient,
  encToClient,
  helloOkForClient,
  helloOkForHost,
  keepAwakeState,
  makeError,
  messageDelta,
  model,
  paired,
  pairFail,
  pairReady,
  peerJoinedForHost,
  peerLeft,
  pong,
  result,
  runState,
  sessionChanged,
  todoList,
  sessionHistory,
  toolEvent,
  permissionRequest,
  permissionResolved,
  questionRequest,
  questionResolved,
  encToRelay,
  encBatchToRelay,
  helloForClient,
  helloForHost,
  pairBegin,
  pairClaim,
  ping,
  resync,
  sessionLeave,
} from '../../src/wire/outbound.js'

const keysOf = (value: object): string[] => Object.keys(value).sort()

test('每条出站控制帧都能被对侧的 schema 解出来（自证往返）', () => {
  const outbound = [
    helloOkForClient('inst-1', 1),
    helloOkForHost('h1', 1),
    pairReady('123456', 180_000),
    paired('c_a1b2c3d4e5f6', 'h1'),
    pairFail('already_used'),
    peerJoinedForHost('c_a1b2c3d4e5f6', 'inst-1', '123456'),
    peerLeft('c_a1b2c3d4e5f6', 'h1'),
    makeError('unknown_session'),
    makeError('bad_frame', 'binary frames are not supported'),
    pong(1234),
    encToClient('c_a1b2c3d4e5f6', 1, 'AAAA'),
    encBatchToClient('c_a1b2c3d4e5f6', [{ seq: 1, ciphertext: 'AAAA' }]),
  ]
  for (const frame of outbound) {
    assert.notEqual(parseRelayFrame(frame), null, `${frame.t} 的出站形状不合法`)
    assert.equal(relayFrame.safeParse(frame).success, true, `${frame.t} 过不了联合类型`)
  }
})

test('F4：hello-ok 对客户端必带 clientId，对主机必带 hostId，另一个都不带', () => {
  assert.deepEqual(keysOf(helloOkForClient('i')), ['clientId', 'role', 't'])
  assert.deepEqual(keysOf(helloOkForHost('h')), ['hostId', 'role', 't'])
})

test('F4：paired 必带 sessionId；pair-ready 必带正整数 ttlMs', () => {
  assert.deepEqual(keysOf(paired('c_x', 'h')), ['hostId', 'sessionId', 't'])
  assert.deepEqual(keysOf(pairReady('123456', 90_000)), ['pairingToken', 't', 'ttlMs'])
})

test('旧事故：给主机的 peer-joined 带 pairingToken（客户端那一条由中继自己写，不带 token）', () => {
  assert.deepEqual(keysOf(peerJoinedForHost('c_x', 'i', '123456')), ['clientId', 'pairingToken', 'sessionId', 't'])
})

test('F11：两个"无会话归属"的载荷里不存在 sessionId 这条路', () => {
  // 编译期第一道：返回类型 EvKeepAwakeState 里根本没有 sessionId 这个属性，
  // 写 `ka.sessionId` 就通不过编译；运行期再对产物键集做一次。
  const ka = keepAwakeState({ enabled: true, active: false, platform: 'darwin', backend: 'caffeinate' })
  assert.equal('sessionId' in ka, false)
  assert.notEqual(parseEvPayload(ka), null)

  const sc = sessionChanged([{ id: 'ses_1' }])
  assert.equal('sessionId' in sc, false)
  assert.notEqual(parseEvPayload(sc), null)
  // 元素里可以有 sessionId 语义的字段吗？不行——那里叫 `id`（F3/F7）。
  assert.deepEqual(keysOf(sc), ['sessions', 't'])
})

test('出站载荷都能被解析，且字段名与 schema 一致', () => {
  const payloads = [
    messageDelta({ messageId: 'm1', delta: 'hi', sessionId: 'ses_1', done: true }),
    messageDelta({ messageId: 'm2', delta: '', done: true }),
    toolEvent({ callId: 'c1', phase: 'started', tool: 'bash' }),
    permissionRequest({ requestId: 'r1', action: '执行 bash', options: [{ id: 'approve', label: '允许' }] }),
    // 桌面与手机同时被问之后，"收回那张卡"成了出站面上的一等公民，所以它也得走同一条自证往返。
    permissionResolved({ requestId: 'r1', sessionId: 'ses_1', by: 'desktop' }),
    permissionResolved({ requestId: 'r1' }),
    questionRequest({
      requestId: 'r1',
      questions: [{ id: 'q1', question: '选哪个环境？', options: [{ id: 'staging', label: '预发' }] }],
    }),
    // 提问卡现在也带到期时刻：主机那边本来就 300 秒就判没答上，手机上看不见倒计时就是骗人。
    questionRequest({ requestId: 'r2', questions: [{ id: 'q1', question: '要哪个？' }], expiresAt: 'x' }),
    // 两端同时问提问这条也一样：输的那一侧要主动收。
    questionResolved({ requestId: 'r1', sessionId: 'ses_1', by: 'desktop' }),
    questionResolved({ requestId: 'r1' }),
    runState({ state: 'idle', detail: 'interrupted', sessionId: 'ses_1' }),
    // 待办清单：全量快照，空数组也是合法载荷（内核清空清单时手机跟着清）。
    todoList({
      todos: [
        { content: '复现问题', status: 'completed' },
        { content: '改完跑全链路', status: 'in_progress' },
      ],
      sessionId: 'ses_1',
    }),
    todoList({ todos: [] }),
    model({ sessionId: 'ses_1', model: 'deepseek-chat', canSwitch: false, reason: '这一代内核只能读当前模型' }),
    model({
      sessionId: 'ses_1',
      model: 'deepseek-chat',
      canSwitch: true,
      provider: 'deepseek',
      options: [{ value: 'deepseek-chat', label: 'DeepSeek Chat' }],
    }),
    result('c1', true, { data: { sessions: [] } }),
    result('', false, { message: '载荷处理失败' }),
  ]
  for (const payload of payloads) {
    assert.notEqual(parseEvPayload(payload), null, `${payload.t} 不合法`)
  }
})

test('model：canSwitch=false 时不下发候选（空数组会让两种"不能切"在手机上一回事）', () => {
  const readOnly = model({
    sessionId: 'ses_1',
    model: 'deepseek-chat',
    canSwitch: false,
    options: [{ value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }],
    reason: '这一代内核只能读当前模型',
  })
  assert.deepEqual(keysOf(readOnly), ['canSwitch', 'model', 'reason', 'sessionId', 't'], '候选被构造器吃掉了')
  assert.notEqual(parseEvPayload(readOnly), null)

  // 空清单同理：canSwitch=true 却没有候选，手机会渲染出一个点的下拉。
  const empty = model({ sessionId: 'ses_1', model: 'deepseek-chat', canSwitch: true, options: [] })
  assert.equal('options' in empty, false)
})

test('model：必须带 sessionId（2026-10-05 用户实测：本会话 space-bunny-free，顶栏显示别的会话的 muse-spark）', () => {
  // 这条判据原来是反的——它断言「sessionId 一个都不许带，模型是全局的」，
  // 于是把**串台写进了协议**。模型是按会话的；全局的只是"新会话默认用哪个"，
  // 拿那个显示，就是用户看到 muse-spark 的直接原因。
  const m = model({ sessionId: 'ses_1', model: 'deepseek-chat', canSwitch: false, provider: 'deepseek' })
  assert.equal(m.sessionId, 'ses_1', '不带会话就无法过滤，别的会话一帧就覆盖本会话')
  assert.notEqual(parseEvPayload(m), null)
})

test('model：sessionId 缺失的帧解析不过（老主机的全局帧宁可被丢掉，也不显示错的）', () => {
  const legacy = { t: 'ev.model', model: 'muse-spark', canSwitch: false }
  assert.equal(parseEvPayload(legacy), null, '没有会话归属的模型帧必须被拒')
})

test('makeError：message 缺席时不留空键（否则对侧会读到 undefined 文案）', () => {
  assert.deepEqual(keysOf(makeError('internal')), ['code', 't'])
  assert.deepEqual(keysOf(makeError('internal', 'boom')), ['code', 'message', 't'])
})

test('sessionHistory：游标只在"还有更早的一页"时出现，一个字段不会自相矛盾', () => {
  const last = sessionHistory({ sessionId: 'ses_1', cmdId: 'c1', items: [] })
  assert.deepEqual(keysOf(last), ['cmdId', 'items', 'sessionId', 't'], '省略游标 = 最初的一页')
  assert.notEqual(parseEvPayload(last), null)

  const more = sessionHistory({
    sessionId: 'ses_1',
    cmdId: 'c1',
    items: [
      { t: 'ev.message_delta', messageId: 'm1', delta: 'hi', role: 'user', done: true },
      { t: 'ev.tool_event', callId: 'c1', phase: 'completed', tool: 'Bash' },
    ],
    nextBeforeSeq: 3,
  })
  assert.deepEqual(keysOf(more), ['cmdId', 'items', 'nextBeforeSeq', 'sessionId', 't'])
  assert.notEqual(parseEvPayload(more), null)
})

test('sessionHistory：条目里的 sessionId 可以缺省（外层已经带了，逐条重复只是白占帧）', () => {
  const page = sessionHistory({
    sessionId: 'ses_1',
    cmdId: 'c1',
    items: [{ t: 'ev.tool_event', callId: 'c1', phase: 'started', tool: 'Bash' }],
  })
  assert.deepEqual(keysOf(page.items[0] ?? {}), ['callId', 'phase', 't', 'tool'])
  assert.notEqual(parseEvPayload(page), null)
})

test('sessionHistory：待办快照也能进历史页（一页里最后一条就是那一页截止时的清单）', () => {
  const page = sessionHistory({
    sessionId: 'ses_1',
    cmdId: 'c1',
    items: [
      { t: 'ev.message_delta', messageId: 'm1', delta: '先看协议', role: 'user', done: true },
      { t: 'ev.todo', todos: [{ content: '改完跑全链路', status: 'in_progress' }] },
      { t: 'ev.todo', todos: [{ content: '改完跑全链路', status: 'completed' }] },
    ],
  })
  const parsed = parseEvPayload(page)
  assert.notEqual(parsed, null, '带 ev.todo 的历史页必须能解出来')
  const items = (parsed as { items?: { t: string; todos?: unknown[] }[] }).items ?? []
  const todos = items.filter((item) => item.t === 'ev.todo')
  assert.equal(todos.length, 2, '两条快照都要在（全量语义，不折叠）')
  assert.deepEqual(todos[1]?.todos, [{ content: '改完跑全链路', status: 'completed' }], '最后一条是那一页截止时的清单')
})

test('sessionHistory：待办条目的 sessionId 不进条目（外层已带，与另两种叶子同一纪律）', () => {
  const page = sessionHistory({
    sessionId: 'ses_1',
    cmdId: 'c1',
    items: [{ t: 'ev.todo', todos: [{ content: '写判据', status: 'pending' }] }],
  })
  assert.deepEqual(keysOf(page.items[0] ?? {}), ['t', 'todos'])
  assert.notEqual(parseEvPayload(page), null)
})

// ── 构造器守自己 schema 的约束（2026-10-06 审计）─────────────────────────
//
// 这些构造器的存在理由就是"参数表 = 允许出现的字段集合"；而它们原来**不校验值**，
// 于是能造出对侧解析器会静默丢掉的帧——现象是"发出去、没回音、也不报错"。

test('pairReady：ttlMs 必须正整数（它是主机改写本地过期时间的唯一依据）', () => {
  assert.deepEqual(pairReady('123456', 90_000), { t: 'pair-ready', pairingToken: '123456', ttlMs: 90_000 })
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => pairReady('123456', bad), `ttlMs=${String(bad)} 不该被接受`)
  }
})

test('enc 构造器：超过中继预算的密文当场抛，不发一帧注定被丢的东西', () => {
  assert.equal(encToClient('c_x', 1, 'AAEC').ciphertext, 'AAEC')
  assert.throws(() => encToClient('c_x', 1, 'A'.repeat(MAX_CIPHERTEXT_BYTES + 1)))
  assert.throws(() => encBatchToClient('c_x', []), '空批量帧会被 schema 拒（items 要 min(1)）')
  assert.doesNotThrow(() => encBatchToClient('c_x', [{ seq: 1, ciphertext: 'AAEC' }]))
})

// ── endpoint → relay 的构造器（2026-10-07）─────────────────────────────────
//
// 补上的这一半。此前宿主插件的七个出站控制帧全是手写字面量，而**只有入站**帧过
// schema —— 给 hello / enc / resync 改字段对它没有任何编译期信号。
// 这组判据守的是"构造器造出来的帧一定过得了对端的 schema"。

test('endpoint → relay 的七个构造器：产物全部过 parseEndpointFrame', () => {
  const frames = [
    helloForHost({ token: 'tok', hostId: 'h1', label: 'mac', capabilities: ['drc.v1'] }),
    helloForClient({ clientId: 'c1', clientMeta: { platform: 'wechat-mp', label: '微信小程序' } }),
    pairBegin('123456'),
    pairClaim('123456'),
    ping(),
    ping(42),
    encToRelay('c_0123456789ab', 7, 'AAEC'),
    encBatchToRelay('c_0123456789ab', [{ seq: 1, ciphertext: 'AAEC' }]),
    sessionLeave('c_0123456789ab'),
    sessionLeave('c_0123456789ab', 'client-1'),
    resync(['c_0123456789ab']),
  ]
  for (const frame of frames) {
    assert.ok(parseEndpointFrame(frame), `构造器产物过不了自己的 schema：${JSON.stringify(frame)}`)
  }
})

test('hello 构造器：protocol 缺省即写出本端版本，capabilities 缺省就不带这个键', () => {
  const bare = helloForHost({})
  assert.ok(bare.t === 'hello')
  assert.deepEqual(keysOf(bare).sort(), ['protocol', 'role', 't'])
  assert.equal(bare.protocol, PROTOCOL_VERSION)
  assert.ok(!('capabilities' in bare), '缺省时不该有这个键——老中继 strip 掉它，但省掉更干净')
  const full = helloForHost({ token: 't', hostId: 'h', label: 'L', capabilities: ['drc.v1', 'drc.host.resync'] })
  assert.deepEqual(keysOf(full).sort(), ['capabilities', 'hostId', 'label', 'protocol', 'role', 't', 'token'])
  // 能力数组是复制进去的：调用方之后改自己的数组，不该改掉已经造好的帧
  const caps: CapabilityId[] = ['drc.v1']
  const frame = helloForClient({ capabilities: caps })
  caps.push('drc.host.info')
  assert.ok(frame.t === 'hello')
  assert.deepEqual(frame.capabilities, ['drc.v1'])
})

test('encToRelay 与 encBatchToRelay 与发给 client 的那对一样守密文长度', () => {
  assert.throws(() => encToRelay('c_x', 1, 'A'.repeat(MAX_CIPHERTEXT_BYTES + 1)))
  assert.throws(() => encBatchToRelay('c_x', []), '空批量帧会被 schema 拒')
  assert.throws(() => encBatchToRelay('c_x', [{ seq: 1, ciphertext: 'A'.repeat(MAX_CIPHERTEXT_BYTES + 1) }]))
  assert.doesNotThrow(() => encToRelay('c_x', 1, 'AAEC'))
})

// ── clientId：中继转发时才补上的那个字段（2026-10-07）─────────────────
//
// 背景：`clientId` 是协议里唯一一个"两端都不生产、只有中继生产"的字段——
// 端点发的 enc 不带它（它不知道中继会怎么转发），中继把客户端上行转给主机时
// 才补上"这是哪台手机"（主机按它做 per-client 回调）。中继因此只能手写字面量，
// 而手写意味着 sessionId/seq/ciphertext 三个字段名在两处各抄一遍。
// 参数表补上它之后那条手写路径消失了——所以下面三条判据守的就是这个接线。

test('encToRelay 带 clientId：键集多一个，且过得了 parseEndpointFrame', () => {
  const bare = encToRelay('c_0123456789ab', 7, 'AAEC')
  assert.deepEqual(keysOf(bare).sort(), ['ciphertext', 'seq', 'sessionId', 't'])
  assert.ok(!('clientId' in bare), '缺省时不该有这个键：端点自己发的帧不带它')

  const tagged = encToRelay('c_0123456789ab', 7, 'AAEC', 'inst-1')
  assert.deepEqual(keysOf(tagged).sort(), ['ciphertext', 'clientId', 'seq', 'sessionId', 't'])
  // 收窄用 `t === 'enc'` 而不是 `as`：构造器的返回类型是 EndpointFrame 联合，
  // 而 `assert.ok` 在 @types/node 里是 asserts 函数，能真的把联合收窄掉。
  assert.ok(tagged.t === 'enc')
  assert.equal(tagged.clientId, 'inst-1')
  assert.ok(parseEndpointFrame(tagged), '带 clientId 的帧必须仍然过 schema（它在 encFrame 里是可选字段）')
})

test('encToRelay 的 seq 可以缺省：缺省即"不发这个键"，不是"发一个 undefined"', () => {
  // schema 里 seq 是可选的（客户端发来的 enc 可以不带），中继转发时原样透传。
  // 写成 `seq: undefined` 会被 JSON.stringify 静默丢掉——线上行为一样，
  // 但源码里那个 undefined 会让人以为"这里总会发一个 seq"。
  const frame = encToRelay('c_0123456789ab', undefined, 'AAEC', 'inst-1')
  assert.ok(!('seq' in frame), '键根本不该存在：`in` 才测得出 `seq: undefined` 与没有它的区别')
  assert.ok(parseEndpointFrame(frame), '不带 seq 的帧必须仍然过 schema')
})

test('encBatchToRelay 原样透传 items：seq 可缺省，且不补 clientId', () => {
  // ⚠️ 批量帧**不带** clientId，而单帧带——这不是漏写，是 F 契约：
  // `encBatchFrame` 的 schema 里压根没有 clientId 字段。加它要改协议。
  // 这条判据的作用是"哪天有人顺手给它补上，让它变红"。
  const items: Array<{ seq?: number; ciphertext: string }> = [{ ciphertext: 'AAEC' }, { seq: 4, ciphertext: 'BBBB' }]
  const frame = encBatchToRelay('c_0123456789ab', items)
  assert.ok(!('clientId' in frame), '批量帧没有 clientId 这个字段（encBatchFrame 的 schema 里没有）')
  assert.ok(frame.t === 'enc-batch')
  const out = frame.items
  assert.ok(out !== undefined, 'items 至少有一项（构造器已经拒了空数组），这里只是让 TS 收窄')
  assert.deepEqual(out, items, '转发是原样透传：中继不在上行方向重编号')
  // 而且必须是**复制**：调用方之后改自己的数组，不该改掉已经造好的帧。
  const first = items[0]
  assert.ok(first !== undefined)
  first.ciphertext = 'ZZZZ'
  assert.equal((out[0] as { ciphertext: string }).ciphertext, 'AAEC')
  assert.ok(parseEndpointFrame(frame), '不带 seq 的 items 必须仍然过 schema')
})

test('resync 的条数上界与 schema 同源：造一条自己收不了的帧是最贵的错误', () => {
  assert.throws(() => resync(Array.from({ length: 2001 }, (_, i) => `c_${i}`)), /2000/)
  assert.doesNotThrow(() => resync([]), '空列表是合法的：主机确实可能一个会话都不剩')
  const ids = ['c_a', 'c_b']
  const built = resync(ids)
  assert.ok(built.t === 'resync')
  assert.deepEqual(built.sessionIds, ids)
  ids.push('c_c')
  assert.equal(built.sessionIds.length, 2, '传入的数组被复制，不被持有')
})

test('makeError：retryAfterMs 缺省就不带这个键，带了必须是正整数', () => {
  assert.deepEqual(keysOf(makeError('internal')), ['code', 't'])
  assert.deepEqual(keysOf(makeError('rate_limited', '太频繁了', 1500)), ['code', 'message', 'retryAfterMs', 't'])
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => makeError('rate_limited', 'x', bad), `retryAfterMs=${String(bad)} 不该被接受`)
  }
  // 发给 client 的错误必须带中文 message（规范 §12.3 E1）：协议层管不了文案，
  // 但可以让"不带文案"变成一个显眼的选择。
  assert.ok(!('message' in makeError('internal')))
})

// ── pair-fail 的 pairingToken（2026-10-07 补）─────────────────────────
//
// 这个字段是为了解决一个**具体的误伤**：帧原先只有 `reason`，而主机侧的处理是
// "作废当前展示的那张"——多码并存时它会作废错的那张（屏幕上是有效的码 B，
// 用户扫了张过期的码 A → B 被丢弃 → B 的 PSK 没了 → 那条通道作废）。
//
// 兼容：可选。不带时老主机那条路逐字不变。

test('pairFail 带 token：键集多一个，且过得了 parseRelayFrame', () => {
  const bare = pairFail('invalid_or_expired')
  assert.deepEqual(keysOf(bare).sort(), ['reason', 't'], '缺省即不发这个字段：老主机那条路必须逐字不变')
  const tagged = pairFail('invalid_or_expired', '123456')
  assert.deepEqual(keysOf(tagged).sort(), ['pairingToken', 'reason', 't'])
  assert.equal(tagged.pairingToken, '123456')
  assert.ok(parseRelayFrame(tagged), '带 token 的帧必须仍然过 relay 侧 schema')
})

test('反向判据：token 上界 16 —— 超长串会让对侧拿它当键去查表', () => {
  // 不是洁癖：主机侧拿它去 `slots.forget(token)`，而一张几十 KB 的串
  // 在日志里会占一行、在查表上是 O(len)。6 位码空间，16 已经很宽。
  assert.equal(parseRelayFrame({ t: 'pair-fail', reason: 'bad_token', pairingToken: '1'.repeat(17) }), null)
  assert.ok(parseRelayFrame({ t: 'pair-fail', reason: 'bad_token', pairingToken: '1'.repeat(16) }))
  assert.equal(parseRelayFrame({ t: 'pair-fail', reason: 'bad_token', pairingToken: '' }), null, '空串没有意义')
})
