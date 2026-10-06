/**
 * 防休眠命令构造器。
 *
 * 这里测的是"参数对不对"，不是"机器真的不睡了没"——后者要在真机上取证。
 * 参数表是这套方案唯一的产物：`-w <pid>` 少一个字符，插件崩溃后机器就会永远不睡。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSleepCommand, detectBackend, isSleepSupported } from '../../src/platform/sleep.js'

test('macOS：默认用 -i -s -w <pid>，不带动 sudo，不绑屏幕', () => {
  assert.deepEqual(buildSleepCommand('darwin', 4321), {
    command: '/usr/bin/caffeinate',
    args: ['-i', '-s', '-w', '4321'],
  })
})

test('macOS：keepDisplay 用 -d/-i/-m/-s/-w <pid>，参数里不许出现"被当成命令"的 token', () => {
  // 2026-10-06 审计：这里原来是 `['-d','-i','-u','disk,display','-w',pid]`——坏的。
  // `-u` 不接参数，`disk,display` 会被 caffeinate 当成要 exec 的 utility，
  // 而 man page 明写 `-w` 在有 utility 时被忽略：**恰好丢掉了"寿命绑到宿主 pid"**，
  // 崩掉的宿主会留下一台永远不睡的机器。这条判据以 man page 的语义为 oracle：
  // caffeinate 的开关（-d/-i/-m/-s/-u）都不带值，唯一带值的是 -t 与 -w。
  const cmd = buildSleepCommand('darwin', 4321, true)
  assert.ok(cmd)
  assert.deepEqual(cmd.args, ['-d', '-i', '-m', '-s', '-w', '4321'])
  assert.equal(cmd.args[cmd.args.length - 1], '4321', '-w 必须带 pid 且在最末')
  assert.ok(cmd.args.includes('-d'), 'keepDisplay 必须真的有 -d，否则屏幕照黑')
  // 任何"上一个 token 不是 -t/-w、自己又不是选项"的孤立参数，都会被当成 utility。
  const optionTakers = new Set(['-t', '-w'])
  for (let i = 0; i < cmd.args.length; i += 1) {
    const arg = cmd.args[i]!
    if (optionTakers.has(arg)) {
      i += 1
      continue
    }
    assert.match(arg, /^-[a-z]+$/, `${arg} 不是 caffeinate 选项，会被当成要 exec 的命令（-w 随之失效）`)
  }
})

test('Linux：--what=idle:sleep 与 --mode=block 缺一不可，末尾必须是 sleep infinity', () => {
  const cmd = buildSleepCommand('linux', 1)
  assert.ok(cmd)
  assert.equal(cmd.command, 'systemd-inhibit')
  assert.ok(cmd.args.includes('--what=idle:sleep'), '只抑制 idle 不抑制 sleep 的话合盖仍会挂起')
  assert.ok(cmd.args.includes('--mode=block'), '默认 delay 只是推迟，策略仍可让机器睡')
  assert.deepEqual(cmd.args.slice(-2), ['sleep', 'infinity'], '锁持有到被 hold 的命令退出')
  assert.ok(!cmd.args.includes('-w'), 'systemd-inhibit 没有 -w 语义，pid 不该出现在这里')
})

test('Windows 与其它平台：返回 null 并报 unsupported，不产出任何 powershell', () => {
  assert.equal(buildSleepCommand('win32', 1), null)
  assert.equal(buildSleepCommand('freebsd', 1), null)
  assert.equal(detectBackend('win32'), 'unsupported')
  assert.equal(detectBackend('darwin'), 'caffeinate')
  assert.equal(detectBackend('linux'), 'systemd-inhibit')
  assert.equal(isSleepSupported('win32'), false)
  assert.equal(isSleepSupported('darwin'), true)
})

test('pid 坏值直接抛（写成 -w undefined 会 spawn 出一个永不退出的 caffeinate）', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => buildSleepCommand('darwin', bad), /正整数/, String(bad))
  }
})
