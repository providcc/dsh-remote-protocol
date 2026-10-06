/**
 * payloads — 数据面载荷目录（host ⇄ client，端到端加密之后才是这些）。
 *
 * 新实现里载荷类型的**唯一事实源**：中继看不见它们（结构性零知识），
 * 插件按 `cmd.*` 分发、按 `ev.*` 推送，小程序按字段名渲染。
 * 校验用 `zod`（选型依据是实测，不是口味：闭包 1 个包、0 运行时依赖、
 * 2.2M ops/s，而中继自己的帧速率上限是 500/s —— 见
 * `docs/legacy-spec/open-source-options.md` §A.5.1 与 §C）。
 *
 * 三个最容易出事的地方，钉在 schema 里而不是散落在各层：
 *
 * 1. **两个 `sessionId` 不是一回事**（F3）。中继帧外层的 `sessionId` 是配对通道 id
 *    （`c_xxx`）；载荷里的 `sessionId` 是 DSH 会话 id，且必须与 `sessions[].id` 同名同值。
 *    混淆它 = 聊天页把所有事件过滤掉，是本协议最贵的一类 bug。
 * 2. `ev.session_changed` 与 `ev.keep_awake_state` **不带** `sessionId`，将来也不许加
 *    （加了会被聊天页当作"别的会话"丢弃，F11）。
 * 3. `SessionSummary.updatedAt` 只能是 ISO-8601 字符串或不下发；给数字时间戳会让小程序
 *    整页渲染抛错，而那个异常被它的 `emit()` 吞掉，表现是"会话列表静默地不更新"（F7）。
 *    这条在**生产端**兜住：`isoOrUndefined()`（见文件末尾）——不要指望校验器替你决定
 *    "数字时间戳该不该发"。
 *
 * 一处刻意的宽松：未知字段被 zod 剥掉。载荷的**生产者是我们自己的 host**，
 * 消费者是手机；插件不会因为不认识某个字段而坏，所以剥未知字段只带来一个好处——
 * 不会把对端多塞的东西原样转发到手机上。
 */
import { z } from 'zod'

/** 会话状态枚举。拼错一个字符，手机端徽标会退化成"空闲"——归档会话因此看着像正常会话。 */
export const SESSION_STATES = [
  'idle',
  'running',
  'detached',
  'archived',
  'awaiting-permission',
  'awaiting-answer',
] as const

const nonEmpty = z.string().min(1)
const isoText = z.string()

const sessionSummary = z.object({
  /** 必填且稳定：小程序拿它做 `wx:key`、跳页参数、标题兜底。 */
  id: nonEmpty,
  state: z.enum(SESSION_STATES).optional(),
  running: z.boolean().optional(),
  title: z.string().optional(),
  workspace: z.string().optional(),
  /** 只接受 ISO 字符串。生产侧请用 `isoOrUndefined()`。 */
  updatedAt: isoText.optional(),
  createdAt: isoText.optional(),
  /** `'subagent'` 表示委派子会话；services carrier 会把这些行整体过滤掉。 */
  origin: z.string().optional(),
})

/** 会话摘要。 */
export type SessionSummary = z.infer<typeof sessionSummary>

export const evSessionChanged = z.object({
  t: z.literal('ev.session_changed'),
  /** **全量快照**，不是增量。会话列表的唯一数据源（F7/F8）。 */
  sessions: z.array(sessionSummary),
  reason: z.string().optional(),
})

export const evMessageDelta = z.object({
  t: z.literal('ev.message_delta'),
  sessionId: nonEmpty.optional(),
  /** 同一条助手消息内稳定且唯一；缺了它不同消息的文本会被拼成一段。 */
  messageId: nonEmpty,
  part: z.number().int().nonnegative().optional(),
  /** 可以为空串——空文本的 done 帧也必须照发（F9）。 */
  delta: z.string(),
  role: z.enum(['assistant', 'user', 'system']).optional(),
  done: z.boolean().optional(),
})

const choiceOption = z.object({ id: nonEmpty, label: nonEmpty })
/** 一个可选项；`id` 会被手机逐字回传，所以它必须是稳定的机器名。 */
export type ChoiceOption = z.infer<typeof choiceOption>

export const evToolEvent = z.object({
  t: z.literal('ev.tool_event'),
  sessionId: nonEmpty.optional(),
  /** 同一次调用稳定唯一：小程序用它原位更新同一行，缺了所有工具事件会挤成一行。 */
  callId: nonEmpty,
  tool: z.string().optional(),
  phase: z.enum(['started', 'args', 'completed', 'failed']),
  title: z.string().optional(),
  argsPreview: z.string().optional(),
  /** 只在 completed/failed 时被渲染，提前发不会显示。 */
  resultPreview: z.string().optional(),
})

export const evPermissionRequest = z.object({
  t: z.literal('ev.permission_request'),
  sessionId: nonEmpty.optional(),
  requestId: nonEmpty,
  action: z.string(),
  resource: z.string().optional(),
  reason: z.string().optional(),
  /** 缺省时小程序自造 `approve`/`reject` 两键；一旦下发，`id` 会被逐字回传。 */
  options: z.array(choiceOption).optional(),
  expiresAt: z.string().optional(),
})

/**
 * 「这张审批卡不用答了」——桌面那一位先答了，或者这次请求本身被撤回。
 *
 * 为什么必须有：主机现在**同时**问桌面和手机（谁先答谁算，插件不许改变宿主自己的行为）。
 * 手机先答时，桌面那张会留到这次工具调用的生命周期结束——那是宿主自己的 `signal` 在收尾，
 * 插件碰不到，只能接受；但**反过来不能靠手机自己超时**：桌面上有人点了之后，
 * 手机那张卡的倒计时还在走、按钮还能点，点下去是对着一个已经关闭的请求做写操作。
 * 所以输的那一侧必须被明确收回。
 *
 * 老版本的小程序收到不认识的 `t` 会**静默忽略**（分发是一串 `if (p.t === …)`），
 * 所以这一帧可以先于小程序那半上线，不会把谁钉死。
 */
export const evPermissionResolved = z.object({
  t: z.literal('ev.permission_resolved'),
  requestId: nonEmpty,
  sessionId: nonEmpty.optional(),
  /** 谁收的场。手机只按"要不要收掉这张卡"读它，所以不做必填。 */
  by: z.enum(['desktop', 'cancelled']).optional(),
})

const questionItem = z.object({
  id: nonEmpty,
  question: nonEmpty,
  multi: z.boolean().optional(),
  options: z.array(choiceOption).optional(),
})
/** 提问卡里的一道题；`id` 是回传时 `answers[].questionId` 的值。 */
export type QuestionItem = z.infer<typeof questionItem>

export const evQuestionRequest = z.object({
  t: z.literal('ev.question_request'),
  sessionId: nonEmpty.optional(),
  requestId: nonEmpty,
  questions: z.array(questionItem),
  /**
   * 这张提问卡什么时候作废（ISO 字符串）。
   *
   * 为什么审批有而提问没有过：主机侧的提问等待本来就带超时（`questionTimeoutMs`，默认 300s），
   * 但手机上那张卡**没有任何倒计时**——用户看不见自己按的按钮什么时候失效，
   * 而这违反伞仓 `docs/PRODUCT.md` §3 第 3 条「超时必须可见」。
   * 与审批那条同一个形状：可选、ISO 字符串、由主机每次发问时现算。
   */
  expiresAt: z.string().optional(),
})

/**
 * 「这张提问卡不用答了」——桌面那一位先答了，或者这次请求本身被撤回/超时。
 *
 * 与 `ev.permission_resolved` 同一条理由：提问现在也是**两端同时问、谁先答谁算**，
 * 输的那一侧必须被明确收回，不能靠手机自己那张没有倒计时的卡一直挂着。
 * 老版本的小程序收到不认识的 `t` 会静默忽略，所以这一帧可以先于小程序那半上线。
 */
export const evQuestionResolved = z.object({
  t: z.literal('ev.question_resolved'),
  requestId: nonEmpty,
  sessionId: nonEmpty.optional(),
  /** 谁收的场。手机只按"要不要收掉这张卡"读它，所以不做必填。 */
  by: z.enum(['desktop', 'cancelled']).optional(),
})

export const evRunState = z.object({
  t: z.literal('ev.run_state'),
  sessionId: nonEmpty.optional(),
  /** 只有这两个值会让手机收起挂着的审批/提问卡，所以类型收紧，不放第三种状态漏出去。 */
  state: z.enum(['running', 'idle']),
  detail: z.string().optional(),
})

/** 一条待办。与内核 `todo/write` 的 `TodoItem` 一一对应——整条原样转发，小程序不猜。 */
const todoItem = z.object({
  /** 待办正文。内核侧不限长，协议侧截到 200 字（面板高度有限，超长的部分看不见）。 */
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

/** 待办清单。 */
export type TodoItem = z.infer<typeof todoItem>
export type EvCompaction = z.infer<typeof evCompaction>
export type EvRetry = z.infer<typeof evRetry>

/**
 * 会话当前的待办清单（**全量快照**，与内核 `todo/write` 同语义）。
 *
 * 为什么放在顶上一颗常驻条里、默认收起：它是"这一轮在干什么"的索引，不是正文——
 * 混进消息流会和堆栈帧互相踩（用户 2026-10-05 点的就是做在顶部、别和排队消息打架）。
 */

/**
 * 模型正在重试（host - client，2026-10-06）。
 *
 * 真机取证：内核 \`llm/retry\` 的 data 带 retry / maxRetries / failure，
 * 而插件一直没有映射它——手机上模型卡住时一片空白，用户以为它死了，
 * 实际是宿主正在重试。这条只带**够拼出人话**的字段：第几次、共几次、什么原因。
 * \`policyKey\` 那段策略 JSON 对用户毫无意义，不出站。
 */
export const evRetry = z.object({
  t: z.literal('ev.retry'),
  sessionId: nonEmpty,
  /** 第几次重试，从 1 起。 */
  attempt: z.number().int().positive(),
  /** 一共最多试几次。 */
  max: z.number().int().positive(),
  /** 失败原因（TRANSPORT / RATE_LIMIT / TIMEOUT …）。可空：宿主偶尔不带。 */
  reason: z.string().max(160).optional(),
})

/**
 * 上下文压缩的起止（host - client，2026-10-06）。
 *
 * \`state='failed'\` 与 \`ended\` 是两件事：前者是“压缩没成”，真机见过
 * \`summarization produced no text summary content\`。合并成一个 ended 会让用户
 * 在上下文已经烂掉的情况下以为一切正常。
 */
export const evCompaction = z.object({
  t: z.literal('ev.compaction'),
  sessionId: nonEmpty,
  state: z.enum(['started', 'ended', 'failed']),
  /** 失败原因（仅 state=failed）。 */
  error: z.string().max(200).optional(),
})

export const evTodo = z.object({
  t: z.literal('ev.todo'),
  sessionId: nonEmpty.optional(),
  todos: z.array(todoItem),
})

export const evKeepAwakeState = z.object({
  t: z.literal('ev.keep_awake_state'),
  enabled: z.boolean(),
  active: z.boolean(),
  platform: nonEmpty,
  backend: nonEmpty,
  reason: z.string().optional(),
})

/** 一个可切换的模型候选。`value` 会被手机逐字回传，所以它必须与主机侧的键同名同值。 */
export const modelOption = z.object({
  /** 机器名（回传用），例如 `deepseek-chat`。 */
  value: nonEmpty,
  /** 给人看的名字；缺省时小程序自己截断 `value`。 */
  label: z.string().optional(),
  provider: z.string().optional(),
})
export type ModelOption = z.infer<typeof modelOption>

/**
 * 当前模型。
 *
 * 为什么要显式带 `canSwitch`，而不是让手机看`options` 有没有值来推断：
 * 「内核不能换」和「内核能换但这里没列全」在手机上必须表现不同 ——
 * 前者下拉要置灰并说明原因，后者是可点的列表。一个字段省掉，代价是
 * 「点了没反应」这个最难排查的现象。
 *
 * **这一代内核只能读**（`agentDefaultModel` 上只有 `currentSelection`），
 * 所以线上 `canSwitch` 是 `false`、`options` 为空。字段先立好，
 * 内核补上写能力后只改宿主那一侧。
 */
export const evModel = z.object({
  t: z.literal('ev.model'),
  /**
   * **哪条会话**在用这个模型。
   *
   * 以前这个字段根本不存在，mp 端把它当全局值显示（2026-10-05 用户实测：
   * 当前会话跑 space-bunny-free，顶栏却显示别的会话切出来的 muse-spark）。
   * 模型是**按会话**的，不带 sessionId 就无法过滤——任何一条别的会话的
   * 模型帧都会覆盖本会话的显示。
   *
   * 必填：老主机不带这个字段时 mp 端宁可忽略这一帧，也不显示错的。
   */
  sessionId: nonEmpty,
  provider: nonEmpty.optional(),
  model: nonEmpty,
  /** 主机能不能换。false 时小程序**不许**渲染成可点的下拉。 */
  canSwitch: z.boolean(),
  /** 候选清单；`canSwitch` 为 true 时至少一项。 */
  options: z.array(modelOption).optional(),
  /** 不能切时给手机一句人话，直接显示，不要让小程序自己编措辞。 */
  reason: z.string().optional(),
})

export const evResult = z.object({
  t: z.literal('ev.result'),
  cmdId: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
})

/**
 * 一页历史条目。**故意复用实时流那两种载荷**，而不是另立一套"历史消息"形状。
 *
 * 理由是小程序侧的成本：聊天页的块流模型（轮次/指令/步骤组/正文）已经把
 * `ev.message_delta` 与 `ev.tool_event` 的回放规则写死了一遍。历史若另立形状，
 * 同一套规则就得写第二遍，而两份实现迟早分叉——表现是"实时看着对、历史看着怪"，
 * 这种缺陷很难靠肉眼发现。
 *
 * 深不递归：这里只允许三种**叶子**载荷，`ev.session_history` 自身不在其中。
 * 第三种是 `evTodo`（2026-10-05 补）：待办是**全量快照**，一页里最后一条就是那一页
 * 截止时的清单；回放它让"进一条跑过的会话也看得见待办"成立，不用等下一次
 * `todo/write`。老手机回放到不认识的 `t` 会静默跳过（分发是 `if (p.t === …)` 串）。
 */
const historyItem = z.discriminatedUnion('t', [evMessageDelta, evToolEvent, evTodo])
/** 历史里的一条。 */
export type HistoryItem = z.infer<typeof historyItem>

/**
 * 主机已有的历史（一次一页，按 seq **升序**）。
 *
 * 三条约定：
 * - `items[].t` 与实时流同构，小程序用**同一条分发路径**回放，不写第二套渲染规则；
 * - **只有游标，没有 `hasMore`**：`nextBeforeSeq` 在 = 还有更早的一页（把它原样回传进
 *   `cmd.session_history.beforeSeq`），不在 = 到底了。用两个字段表达同一件事，
 *   迟早会出现"说还有、却没给游标"这种自相矛盾的载荷，而它的表现是——
 *   手机上「加载更早」点了没反应，且没有任何报错。一个字段就没有这种状态。
 * - 翻页游标由**主机**给：一条原始内核事件可能被折叠成 0/1/2 条线格式条目，
 *   小程序既不知道折叠规则也不该知道，按条数自己推算迟早会跳过或重发一段。
 * - 条目里不带 `ev.run_state`：运行态是"此刻"的事，回放历史不该去改顶栏。
 */
export const evSessionHistory = z.object({
  t: z.literal('ev.session_history'),
  sessionId: nonEmpty,
  cmdId: nonEmpty,
  items: z.array(historyItem),
  /** 有更早的一页时给出游标；**没有这个字段就表示这是最初的一页**。 */
  nextBeforeSeq: z.number().int().nonnegative().optional(),
})

/** evSessionChanged 的推导类型。 */
export type EvSessionChanged = z.infer<typeof evSessionChanged>
/** evMessageDelta 的推导类型。 */
export type EvMessageDelta = z.infer<typeof evMessageDelta>
/** evToolEvent 的推导类型。 */
export type EvToolEvent = z.infer<typeof evToolEvent>
/** evPermissionRequest 的推导类型。 */
export type EvPermissionRequest = z.infer<typeof evPermissionRequest>
/** evPermissionResolved 的推导类型。 */
export type EvPermissionResolved = z.infer<typeof evPermissionResolved>
/** evQuestionRequest 的推导类型。 */
export type EvQuestionRequest = z.infer<typeof evQuestionRequest>
/** evQuestionResolved 的推导类型。 */
export type EvQuestionResolved = z.infer<typeof evQuestionResolved>
/** evRunState 的推导类型。 */
export type EvRunState = z.infer<typeof evRunState>
/** evTodo 的推导类型。 */
export type EvTodo = z.infer<typeof evTodo>
/** evKeepAwakeState 的推导类型。 */
export type EvKeepAwakeState = z.infer<typeof evKeepAwakeState>
/** evModel 的推导类型。 */
export type EvModel = z.infer<typeof evModel>
/** evResult 的推导类型。 */
export type EvResult = z.infer<typeof evResult>
/** evSessionHistory 的推导类型。 */
export type EvSessionHistory = z.infer<typeof evSessionHistory>
/** cmdSessionHistory 的推导类型。 */
export type CmdSessionHistory = z.infer<typeof cmdSessionHistory>
/** cmdSendPrompt 的推导类型。 */
export type CmdSendPrompt = z.infer<typeof cmdSendPrompt>
/** cmdAnswer 的推导类型。 */
export type CmdAnswer = z.infer<typeof cmdAnswer>
/** cmdResolvePermission 的推导类型。 */
export type CmdResolvePermission = z.infer<typeof cmdResolvePermission>
/** cmdInterrupt 的推导类型。 */
export type CmdInterrupt = z.infer<typeof cmdInterrupt>
/** cmdListSessions 的推导类型。 */
export type CmdListSessions = z.infer<typeof cmdListSessions>
/** cmdKeepAwake 的推导类型。 */
export type CmdKeepAwake = z.infer<typeof cmdKeepAwake>
/** cmdNewSession 的推导类型。 */
export type CmdNewSession = z.infer<typeof cmdNewSession>

/**
 * 出站载荷（host → client）。小程序解密后按 `t` 分发，认不出的类型被**静默丢弃**，
 * 所以新增名字安全，改既有语义不安全。
 */
export const evPayload = z.discriminatedUnion('t', [
  evSessionChanged,
  evMessageDelta,
  evToolEvent,
  evPermissionRequest,
  evPermissionResolved,
  evQuestionRequest,
  evQuestionResolved,
  evRunState,
  evTodo,
  evRetry,
  evCompaction,
  evKeepAwakeState,
  evModel,
  evResult,
  evSessionHistory,
])
export type EvPayload = z.infer<typeof evPayload>

// ── 入站载荷（client → host）─────────────────────────────────────────

/**
 * 一条随消息带的图片附件（2026-10-04 加，可选）。
 *
 * 为什么是 base64 而不是路径：图片在**手机上**，主机那头没有这个文件；而整条载荷
 * 是 JSON（之后还要 seal 成密文帧），二进制在 JSON 里只有 base64 一条路。
 * 于是体积纪律全在 mp 侧：`wx.compressImage` 先压（质量 + 最长边），
 * 中继 `DRC_MAX_MSG_BYTES` 是硬上限（默认 1MB，见 server 仓），超了整条帧被掐。
 * **只收 jpeg**：相册选完压出来就是 jpeg，png 的先让 mp 转（ compressImage 统一输出）。
 */
export const imageAttachment = z.object({
  /** 落盘用的文件名（mp 侧生成，形如 `img-<ms>-<n>.jpg`；主机侧还会再收敛一次字符集）。 */
  name: nonEmpty,
  mediaType: z.literal('image/jpeg'),
  /** base64 字节，**不带** `data:` 前缀。 */
  data: nonEmpty,
  /** 压缩后的像素尺寸，主机写旁车元数据用（排错时对得上）。 */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
})
export type ImageAttachment = z.infer<typeof imageAttachment>

/**
 * 文件附件（2026-10-05 加，用户："文件附件也支持一下"）。
 *
 * 与图片的三处不同，都是被文件这件事本身逼出来的：
 * 1. **没有 mediaType 白名单**。图片那边收 `image/jpeg` 字面量，是因为相册出来
 *    必然能被画布重编码成 jpeg；文件没有这一步，pdf/doc/xlsx 各有各的格式，
 *    主机这边只记录类型、不解析内容（真要解析得引入一整柜 MIME 嗅探，不值）。
 * 2. **没有体积以外的第二道内容校验**。图片有 JPEG 魔数，文件的"魔数"族类太多，
 *    所以纪律全落在 mp 侧的两道闸与主机的单条上限上。
 * 3. **文件名就是落盘名**（图片会被强改成 .jpg）。扩展名必须留着——Agent
 *    认文件靠的就是它。收敛仍走 `safeSegment`：手机传来的名字是不可信输入。
 *
 * 与图片共用同一条预算（见 `MAX_ATTACH_TOTAL_BYTES`）：中继单帧 1MB 是硬上限，
 * 超了不是"发不出去"而是整帧被掐、socket 1009 断开。所以文件也不做压缩——
 * 超预算的被挡下并说清，而不是悄悄砍掉一半内容。
 */
export const fileAttachment = z.object({
  /** 落盘用的文件名（mp 侧来自 `chooseMessageFile` 的 name，形如 `report.pdf`）。 */
  name: nonEmpty,
  /** 类型标签（mp 侧用 `chooseMessageFile` 的 type，即不带点的扩展名）。只记录，不解析。 */
  mediaType: z.string().max(64).optional(),
  /** base64 字节，**不带** `data:` 前缀。 */
  data: nonEmpty,
})

export type FileAttachment = z.infer<typeof fileAttachment>

export const cmdSendPrompt = z.object({
  t: z.literal('cmd.send_prompt'),
  cmdId: nonEmpty,
  /** DSH 会话 id，不是配对通道 id。 */
  sessionId: nonEmpty,
  text: z.string(),
  /**
   * 随消息的图片附件。**可选**：老版本手机不带这个字段，老主机看到也不认
   * （zod 默认 strip 未知键，而 text 照旧）——所以这是向后兼容的增补，不升协议版本。
   * 上限 4 张：再多对"看清楚这张图"没有帮助，只是把帧撑爆。
   */
  images: z.array(imageAttachment).max(4).optional(),
  /**
   * 随消息的文件附件。与 images 同一条理由（可选、strip、不升版本）。
   * 上限 4 个：再多就不是"随手带个文件"，该换成别的方式交付。
   */
  files: z.array(fileAttachment).max(4).optional(),
})

const answerItem = z.object({
  questionId: nonEmpty,
  selected: z.array(nonEmpty),
  /** 整卡共享的一个自由文本框，不是每题一个（取证 legacy-spec/mp-client-contract.md §2.3）。 */
  freeText: z.string().optional(),
})
/** 一道题的作答。 */
export type AnswerItem = z.infer<typeof answerItem>

export const cmdAnswer = z.object({
  t: z.literal('cmd.answer'),
  cmdId: nonEmpty,
  sessionId: nonEmpty,
  requestId: nonEmpty,
  answers: z.array(answerItem),
})

export const cmdResolvePermission = z.object({
  t: z.literal('cmd.resolve_permission'),
  cmdId: nonEmpty,
  sessionId: nonEmpty,
  requestId: nonEmpty,
  /** 主机下发哪个 `options[].id`，手机就回传哪个，逐字——所以不做枚举收紧。 */
  decision: nonEmpty,
  note: z.string().optional(),
})

export const cmdInterrupt = z.object({
  t: z.literal('cmd.interrupt'),
  cmdId: nonEmpty,
  sessionId: nonEmpty,
})

export const cmdListSessions = z.object({
  t: z.literal('cmd.list_sessions'),
  cmdId: nonEmpty,
})

/**
 * 新建一个会话。
 *
 * **不带标题**：命名的权力在主机那一侧（内核 `sessionController.commands.create({})`
 * 不传 sessionId 就分配一个新的，不传 cwd 就用默认项目目录）。手机擅自编一个"新会话"
 * 塞过去，只会盖掉主机自己的命名规则，而且第一次发指令后标题还会被内核改掉——
 * 那时候用户看到的就是一条**自己改过名字的会话又变了名**。
 *
 * 回执走 `ev.result`：它本来就有 `cmdId`（对答靠它匹配）与 `ok`/`message`
 * （失败时手机要能说出原因），`data.sessionId` 带上新会话的 id。
 * 为这一件事新立一个 `ev.*` 载荷不值得——那会让"结果回执"有两条并行的路。
 */
export const cmdNewSession = z.object({
  t: z.literal('cmd.new_session'),
  cmdId: nonEmpty,
})

export const cmdKeepAwake = z.object({
  t: z.literal('cmd.keep_awake'),
  cmdId: nonEmpty,
  enabled: z.boolean(),
  /** 单位秒；`0` = 保持到被显式关闭。关掉开关时小程序**不带**这个字段。 */
  idleReleaseSec: z.number().int().nonnegative().optional(),
})

/**
 * 读主机上已有的历史（`sessionId` 是 DSH 会话 id，不是配对通道 id，F3）。
 *
 * 分页语义刻意做成「**游标由主机给、小程序原样回传**」：
 * - 不带 `beforeSeq` = 要最新的一页；
 * - 带 `beforeSeq` = 要 `seq < beforeSeq` 的那一页，取值来自上一次响应的 `nextBeforeSeq`。
 *
 * 为什么不按"第几页/每页 N 条"来切：一条原始内核事件可能被折叠成 0 条（空文本的
 * assistant/message）、1 条或 2 条（tool/call + tool/result）线格式条目，
 * 小程序既不知道折叠规则也不该知道。让它按条数推算翻页，迟早会跳过或重发一段。
 */
export const cmdSessionHistory = z.object({
  t: z.literal('cmd.session_history'),
  cmdId: nonEmpty,
  sessionId: nonEmpty,
  beforeSeq: z.number().int().nonnegative().optional(),
  /** 上限 200：一次翻页要不动整条会话，也不能是一条能顶满中继帧预算的巨帧。 */
  limit: z.number().int().positive().max(200).optional(),
})

/**
 * 手机发来的命令，共 8 种——就是 `mp/core/client.js` 的便捷方法能产出的全部。
 *
 * 旧实现还有一个 `cmd.subscribe`：它的 handler 只回一个 `ev.result{ok:true}`，
 * `sessionIds`/`includeContent` 没有任何过滤效果，而小程序从不发它。
 * 本版不实现它（取证 legacy-spec/relay-and-wireformat.md §4.1 的"事实上的 no-op"）。
 */
export const cmdPayload = z.discriminatedUnion('t', [
  cmdSendPrompt,
  cmdAnswer,
  cmdResolvePermission,
  cmdInterrupt,
  cmdListSessions,
  cmdKeepAwake,
  cmdSessionHistory,
  cmdNewSession,
])
export type CmdPayload = z.infer<typeof cmdPayload>

/** 解析手机发来的命令；非法返回 null（调用方决定丢弃还是回 `ev.result{ok:false}`）。 */
export function parseCmdPayload(value: unknown): CmdPayload | null {
  const parsed = cmdPayload.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 解析事件载荷（中继 e2e 审计与插件自测用）。 */
export function parseEvPayload(value: unknown): EvPayload | null {
  const parsed = evPayload.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** 载荷类型名常量（分发与测试断言用，避免各处手打字符串）。 */
export const PAYLOAD_TYPES = {
  cmdSendPrompt: 'cmd.send_prompt',
  cmdAnswer: 'cmd.answer',
  cmdResolvePermission: 'cmd.resolve_permission',
  cmdInterrupt: 'cmd.interrupt',
  cmdListSessions: 'cmd.list_sessions',
  cmdKeepAwake: 'cmd.keep_awake',
  cmdSessionHistory: 'cmd.session_history',
  cmdNewSession: 'cmd.new_session',
  evSessionChanged: 'ev.session_changed',
  evMessageDelta: 'ev.message_delta',
  evToolEvent: 'ev.tool_event',
  evPermissionRequest: 'ev.permission_request',
  evPermissionResolved: 'ev.permission_resolved',
  evQuestionRequest: 'ev.question_request',
  evQuestionResolved: 'ev.question_resolved',
  evRunState: 'ev.run_state',
  evTodo: 'ev.todo',
  evRetry: 'ev.retry',
  evCompaction: 'ev.compaction',
  evKeepAwakeState: 'ev.keep_awake_state',
  evModel: 'ev.model',
  evResult: 'ev.result',
  evSessionHistory: 'ev.session_history',
} as const

/**
 * 生产侧兜住 F7：只有能被 `Date.parse` 认出来的值才作为 ISO 字符串下发，
 * 否则**整个字段省略**（小程序把它当可选字段，缺省不显示时间角标）。
 *
 * 为什么不在校验器里管：校验器只管收到的东西对不对；而这里要防的是我们自己
 * 把内核给的**毫秒数**直接塞进去——那是一次"发得出去、对方静默坏掉"的错误。
 */
export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return undefined
}
