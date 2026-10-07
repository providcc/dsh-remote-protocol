/**
 * limits — 三端共享的**数值预算**。
 *
 * ## 为什么把它们从 `frames.ts` 里搬出来
 *
 * 附件条数这个数曾经在三棵仓里各写一遍（协议层两处 `.max(4)`、小程序 `MAX_ATTACH`
 * 加两处 `slice(0,4)`、主机侧 `maxCount ?? 4`）。四个 4 之间没有任何东西连着：
 * 改一处不会有编译错误、不会有测试变红，而症状是"带了 5 个，第 5 个静默消失"。
 * 2026-10-07 靠 `e2e/wire-surface.test.mjs` 的逐处正则比对把它钉住了——那已经比
 * 什么都没有好得多，但它仍然是**一次正则比对**，不是类型级共享。
 *
 * 于是规矩变成：凡是"三端都要知道同一个数"的预算，MUST 住在这里，
 * 并且 MUST 只有一个定义点。小程序引不了本包（它要打进小程序包），
 * 那边靠伞仓的闸门比对字面量——但**数**的来源只能有一个。
 *
 * ## 为什么 `MAX_RELAY_MESSAGE_BYTES` 从 `frames.ts` 搬到这里而不是新加一个
 *
 * 它被中继当默认值 import（`dsh-remote-server/src/config.ts:28` 从
 * `dsh-remote-wire/frames` 引）。所以 `frames.ts` MUST NOT 停止导出它——
 * 见文件末尾的转出，那条转出不是"顺手留个兼容"，而是**依赖**：
 * 把符号从消费方的导入路径上撤掉，是一个只会在下游编译期爆炸的破坏性变更。
 */

/** 中继单条 WS 消息的默认预算（`DRC_MAX_MSG_BYTES` 默认 1 MiB）。 */
export const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024

/**
 * 一条密文记录的上限。取 `中继预算 - 8 KiB`：信封 JSON（t/sessionId/seq 与引号）
 * 远小于 8 KiB，留这个余量是为了让"合法帧必然过得了中继"成为**结构性保证**，
 * 而不是靠估算。
 *
 * 历史上这里写死 512 KiB，而手机侧附件闸门是 512 KiB **原始字节**——
 * base64 胀 4/3 再套 secretbox 封装，一条合法的四图消息密文约 930 KiB，
 * **过不了自己家的 schema**，用户看到的是"图片/文件发不出去"。
 */
export const MAX_CIPHERTEXT_BYTES = MAX_RELAY_MESSAGE_BYTES - 8 * 1024

/** 随 `cmd.send_prompt` 走的图片上限。协议层、小程序、主机三处必须是同一个数。 */
export const MAX_IMAGE_ATTACHMENTS = 4

/** 随 `cmd.send_prompt` 走的文件上限。与图片同一条理由，也必须同值。 */
export const MAX_FILE_ATTACHMENTS = 4

/**
 * 单个附件的原始字节上限。
 *
 * 注意口径：这是**原始字节**，不是 base64 之后的长度。两者的差 4/3，
 * 而帧预算是按密文算的——小程序侧 `estimateWireFrameBytes` 负责那个换算，
 * 这里只放**名义上限**，避免三个地方各做一次乘除法（其中一处曾经写错过，
 * 症状是"一条 6 字节的小消息被估成 3.1MB 而当场拦下"）。
 */
export const MAX_ATTACHMENT_BYTES = 512 * 1024

/** 一条消息里全部附件的原始字节总和上限。同上口径。 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 512 * 1024

/**
 * `cmdId` 去重窗口（毫秒）。规范 §10.2 I2/I4。
 *
 * MUST ≥ client 的最大命令重试间隔，否则"重发的那条"落在窗口外，
 * 于是它会被执行第二次——去重窗口比超时窗口短，等于没有去重。
 * client 侧现状是 `COMMAND_TIMEOUT_MS = 12_000`，这里留了三倍余量。
 */
export const IDEMPOTENCY_WINDOW_MS = 5 * 60 * 1000

/** 去重台账的容量上界。超出时按最旧淘汰——它是有界缓存，不是账本。 */
export const IDEMPOTENCY_CAPACITY = 256
