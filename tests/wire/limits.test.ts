/**
 * 三端共享的数值预算（规范 §11.1）。
 *
 * 附件条数这个数曾经在三棵仓里各写一遍（协议层两处、小程序三处、主机两处），
 * 四个 4 之间没有任何东西连着。伞仓的闸门按**字面量**比对它们，但协议层自己
 * 至少要保证：它导出的是**同一个**常量，而不是两个长得一样的字面量。
 *
 * 变异验证：把 payload 里的 `.max(MAX_IMAGE_ATTACHMENTS)` 改回 `.max(4)` 本身不会红
 * （值一样），所以这条判据守的是"导出的值与手机侧硬编码的数一致"这个不变量；
 * 真正的漂移检测在 `e2e/wire-surface.test.mjs`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IDEMPOTENCY_CAPACITY,
  IDEMPOTENCY_WINDOW_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_CIPHERTEXT_BYTES,
  MAX_FILE_ATTACHMENTS,
  MAX_IMAGE_ATTACHMENTS,
  MAX_RELAY_MESSAGE_BYTES,
} from '../../src/wire/limits.js'
import { MAX_CIPHERTEXT_BYTES as VIA_FRAMES } from '../../src/wire/frames.js'
import { cmdSendPrompt, parseCmdPayload } from '../../src/wire/payloads.js'

test('密文上限由中继预算倒推，且比它小（余量是信封的 8 KiB）', () => {
  assert.equal(MAX_RELAY_MESSAGE_BYTES, 1024 * 1024)
  assert.equal(MAX_CIPHERTEXT_BYTES, MAX_RELAY_MESSAGE_BYTES - 8 * 1024)
  assert.ok(MAX_CIPHERTEXT_BYTES < MAX_RELAY_MESSAGE_BYTES)
  // 从 frames 转出的必须是同一个值——那是中继的导入路径
  assert.equal(VIA_FRAMES, MAX_CIPHERTEXT_BYTES)
})

test('图片与文件上限同值：两类附件在手机侧共用一个 MAX_ATTACH', () => {
  assert.equal(MAX_IMAGE_ATTACHMENTS, 4)
  assert.equal(MAX_FILE_ATTACHMENTS, MAX_IMAGE_ATTACHMENTS)
})

test('附件字节上限：单条与总量同值同口径（原始字节，不是 base64 之后）', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 512 * 1024)
  assert.equal(MAX_ATTACHMENT_TOTAL_BYTES, MAX_ATTACHMENT_BYTES)
})

test('schema 真正用上了这些常量：第 5 个附件被拒', () => {
  const images = Array.from({ length: MAX_IMAGE_ATTACHMENTS }, (_, i) => ({
    name: `img-${i}.jpg`,
    mediaType: 'image/jpeg' as const,
    data: 'AAAA',
  }))
  assert.ok(cmdSendPrompt.safeParse({ t: 'cmd.send_prompt', cmdId: 'c', sessionId: 's', text: '', images }).success)
  assert.equal(
    parseCmdPayload({ t: 'cmd.send_prompt', cmdId: 'c', sessionId: 's', text: '', images: [...images, images[0]] }),
    null,
    '超出上限的整条命令被拒，而不是"多出来的那个静默消失"',
  )
})

test('去重窗口的默认值的量级：它必须远大于 client 的 12 秒命令超时', () => {
  assert.equal(IDEMPOTENCY_WINDOW_MS, 5 * 60 * 1000)
  assert.ok(IDEMPOTENCY_WINDOW_MS > 12_000, '窗口比 client 的重试间隔短 = 没有窗口')
  assert.equal(IDEMPOTENCY_CAPACITY, 256)
})
