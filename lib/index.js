/**
 * dsh-destinywind-ai-opencode · 把本机 OpenCode CLI 接成 DSH 的执行分担工具。
 *
 * 设计要点（与「把 opencode 当模型 provider」彻底不同的一条路线）：
 *  - 本插件**不注册任何 LLM provider**，也不碰模型选择器。模型由 DSH 已有的
 *    provider 提供，选择器里不会多出任何条目。
 *  - 本插件只注册**工具**：主 AI 在任务过程中可以调用 opencode_delegate，
 *    把一段自包含的子任务交给本机 opencode CLI 的 build 代理独立执行。
 *    opencode 在自己的进程里有完整的读写文件、执行命令能力，干完活把结果
 *    文本交回来；中间过程（它读了多少文件、跑了什么命令）不进入主上下文。
 *  - 因此它解决的是「分担」：主 AI 负责规划与协调，重活外包给 opencode，
 *    一份提示词换一份结果，主上下文保持干净。
 *
 * 为什么不走模型 provider 路线（历史结论，避免重蹈覆辙）：
 *  - opencode 的免费档只允许 opencode 自己的客户端调用（服务端校验 UA +
 *    客户端通道），直连 Zen 的 OpenAI 兼容端点会被拒：
 *    「OpenCode's free tier can only be used from within OpenCode」。
 *  - 退一步用 `opencode run` 当模型后端也不行：它是黑盒 agent，提示词文本进、
 *    最终文本出，DSH 的工具定义在桥接层被丢弃，模型永远产不出 tool-call，
 *    agent 循环「说一句话就结束」。所以正确姿势是把它当**工具**而不是模型。
 */

import { spawn } from 'node:child_process'
import { homedir, hostname } from 'node:os'

/** 稳定的 cordis 插件名（宿主按此识别插件，必须导出）。 */
export const name = 'dsh-destinywind-ai-opencode'
/** 依赖宿主的 tools 服务，必须导出：宿主先读 inject 决定注入哪些服务。 */
export const inject = ['tools']

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

const TOOL_NAME = 'opencode_delegate'
const CLI_DEFAULT = 'opencode'
const AGENT_DEFAULT = 'build'
const TIMEOUT_DEFAULT_MS = 600000
const TIMEOUT_MIN_MS = 10000
const TIMEOUT_MAX_MS = 3600000
const OUTPUT_LIMIT = 60000
const TASK_MIN_LENGTH = 8

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取一个非空字符串，否则回落。 */
function asString(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** 把毫秒数夹到合法区间。 */
function clampTimeout(value) {
  if (!Number.isFinite(value)) return TIMEOUT_DEFAULT_MS
  const n = Math.trunc(value)
  if (n < TIMEOUT_MIN_MS) return TIMEOUT_MIN_MS
  if (n > TIMEOUT_MAX_MS) return TIMEOUT_MAX_MS
  return n
}

/** 超长输出保留头尾（中间省略），避免一次性灌爆主上下文。 */
function clipOutput(text) {
  if (text.length <= OUTPUT_LIMIT) return text
  const head = Math.floor(OUTPUT_LIMIT * 0.7)
  const tail = OUTPUT_LIMIT - head
  const omitted = text.length - OUTPUT_LIMIT
  return `${text.slice(0, head)}\n\n[... 省略 ${omitted} 字符 ...]\n\n${text.slice(text.length - tail)}`
}

/** 解析可能带 provider 前缀的模型名，保证形如 provider/model。 */
export function normalizeModel(value) {
  const raw = asString(value, '')
  if (raw === '') return ''
  if (raw.includes('/')) return raw
  return `opencode/${raw}`
}

/**
 * 从工具执行上下文里找会话工作区。
 *
 * 为什么需要：不传 `--dir` 时 opencode 继承的是 **DSH 宿主进程** 的工作目录
 * （本机实测为 `C:\Users\raoke\.dsh\profiles\desktop`），而不是用户以为的会话
 * 工作区；于是它「完成」了却把活干在了别处，还查不到痕迹。
 * 这里按多个可能的字段名做兼容探测，取不到就返回空串（交给进程 cwd）。
 */
export function workspaceOf(exec) {
  if (!isRecord(exec)) return ''
  const candidates = [exec.cwd, exec.workspace, exec.workspaceRoot, exec.workingDirectory]
  for (const candidate of candidates) {
    const value = asString(candidate, '')
    if (value !== '') return value
  }
  const session = isRecord(exec.session) ? exec.session : undefined
  if (session !== undefined) {
    const value = asString(session.cwd, '')
    if (value !== '') return value
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* opencode CLI 调用                                                   */
/* ------------------------------------------------------------------ */

/**
 * 跑一次 `opencode run`，把子任务交给 opencode 的代理执行。
 *
 * 参数形态（已按 `opencode run --help` 实测校准）：
 *   opencode run --format=json -m <provider/model> --agent <agent> --dir <cwd> <task>
 * 注意：CLI **没有** --no-color 选项，历史上误加它就导致 exit 1 并打印帮助。
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runOpencode(options) {
  const {
    cli = CLI_DEFAULT,
    task,
    model = '',
    agent = AGENT_DEFAULT,
    cwd = '',
    timeoutMs = TIMEOUT_DEFAULT_MS,
    signal,
    env = process.env,
  } = options

  const args = ['run', '--format=json']
  if (model !== '') args.push('-m', model)
  if (agent !== '') args.push('--agent', agent)
  if (cwd !== '') args.push('--dir', cwd)
  args.push(task)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cli, args, {
        cwd: cwd !== '' ? cwd : undefined,
        env,
        windowsHide: true,
        // stdin 必须是 ignore：`opencode run` 会一直等 stdin 结束才动手，
        // 默认的 pipe 若没人关闭它，进程就静静挂死到超时（本机实测：60s 零输出）。
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows 上 opencode 的入口常是 .cmd / .ps1 包装，node 的 spawn 不做
        // PATHEXT 解析，且直接 spawn 包装脚本会 EINVAL。走 shell 让系统解析。
        shell: process.platform === 'win32',
      })
    } catch (error) {
      reject(new Error(`无法启动 "${cli}"：${error instanceof Error ? error.message : String(error)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (signal !== undefined) signal.removeEventListener?.('abort', onAbort)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      try { child.kill() } catch { /* 进程可能已退出 */ }
      reject(new Error('opencode 调用已被取消'))
    }

    if (signal !== undefined) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener?.('abort', onAbort, { once: true })
    }

    timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      try { child.kill() } catch { /* 忽略 */ }
      reject(new Error(`opencode 执行超时（${timeoutMs}ms），已终止。可改用更小的子任务或调大 timeoutMs`))
    }, timeoutMs)

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk) })

    child.on?.('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      const hint = error?.code === 'ENOENT'
        ? `找不到可执行文件 "${cli}"。若用 npm 安装，Windows 上多为 `
          + `node_modules/opencode-ai/bin/opencode.exe，可在插件配置里把 opencodeCmd 指向该 exe 的完整路径`
        : String(error?.message ?? error)
      reject(new Error(hint))
    })

    child.on?.('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}

/* ------------------------------------------------------------------ */
/* NDJSON 结果提取                                                     */
/* ------------------------------------------------------------------ */

/**
 * 从 `opencode run --format=json` 的 NDJSON 输出里取出正文与错误。
 *
 * 事件形态（本机实测）：
 *   {"type":"text","part":{"type":"text","text":"..."}}        正文增量
 *   {"type":"reasoning","part":{"text":"..."}}                 思考增量
 *   {"type":"step_finish","part":{"reason":"stop","tokens":{}}} 收尾
 *   {"type":"error","error":{"data":{"message":"...","statusCode":429}}}
 */
export function extractResult(stdout) {
  const parts = []
  let error = ''
  let status = undefined
  let sawJson = false

  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.startsWith('{')) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (!isRecord(event)) continue
    sawJson = true
    const part = isRecord(event.part) ? event.part : {}
    if (event.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      parts.push(part.text)
      continue
    }
    if (event.type === 'error') {
      const err = isRecord(event.error) ? event.error : {}
      const data = isRecord(err.data) ? err.data : {}
      if (Number.isFinite(data.statusCode)) status = data.statusCode
      const message = asString(data.message, asString(err.message, 'opencode 返回了未说明的错误'))
      if (error === '') error = message
    }
  }

  return { text: parts.join(''), error, status, sawJson }
}

/** 判断 opencode 的结果是不是「限流」这类可重试的临时故障。 */
export function isRateLimited(message, status) {
  if (status === 429) return true
  return /rate limit|too many requests|429/i.test(String(message ?? ''))
}

/* ------------------------------------------------------------------ */
/* 工具定义                                                            */
/* ------------------------------------------------------------------ */

/** 构造 opencode_delegate 的工具定义（导出以便单测直接校验结构）。 */
export function createDelegateTool(options = {}) {
  const {
    resolveSettings = () => ({}),
    logger = { info() {}, warn() {}, error() {} },
    runner = runOpencode,
  } = options

  return {
    name: TOOL_NAME,
    description: [
      '把一个自包含的子任务交给本机 OpenCode CLI 的执行代理（build，可读写文件、跑命令）独立完成，并把结果文本取回。',
      '适合：机械但耗时的编码活（写一个模块、批量重命名、补测试、修静态检查报错）、需要独立探查大量文件的调研、在主上下文里不想展开的中间过程。',
      '不适合：需要与本会话上下文紧密交互的细节决策、一句话就能答的简单问题（自己直接答更快）。',
      '调用要点：task 必须是自包含的完整指令（对方看不到本会话历史），写清目标、约束、期望的产出与验收标准；它会真实改动工作区文件。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '交给 opencode 执行的完整子任务指令。必须自包含：说明目标、背景、约束、期望产出与验收标准，因为对方看不到当前会话历史。',
        },
        cwd: {
          type: 'string',
          description: 'opencode 的工作目录（绝对路径）。留空则用会话工作区；跨目录作业时显式指定。',
        },
        model: {
          type: 'string',
          description: 'opencode 侧使用的模型（形如 provider/model，或只给模型名自动补 opencode/ 前缀）。留空用 opencode 侧默认模型。',
        },
        agent: {
          type: 'string',
          description: 'opencode 的执行代理名。build 为全权限（可改文件，默认），plan 为只读规划代理。',
        },
        timeoutMs: {
          type: 'number',
          description: `超时毫秒数，默认 ${TIMEOUT_DEFAULT_MS}（10 分钟），范围 ${TIMEOUT_MIN_MS}-${TIMEOUT_MAX_MS}。大重构任务可调大。`,
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', description: 'opencode 是否成功完成（退出码 0 且未报错）' },
          summary: { type: 'string', description: 'opencode 的最终答复正文' },
          model: { type: 'string', description: '实际使用的模型（provider/model）' },
          agent: { type: 'string', description: '实际使用的执行代理' },
          cwd: { type: 'string', description: '实际工作目录' },
          exitCode: { type: 'number', description: 'opencode 进程退出码' },
          durationMs: { type: 'number', description: '耗时毫秒' },
          rateLimited: { type: 'boolean', description: '是否因上游限流失败（可稍后重试或换模型）' },
        },
        required: ['ok', 'summary'],
        additionalProperties: false,
      },
      render(_args, value) {
        const v = isRecord(value) ? value : {}
        const lines = []
        if (v.ok === true) lines.push('[opencode 分担完成]')
        else lines.push('[opencode 分担未成功]')
        const meta = []
        if (asString(v.model) !== '') meta.push(`模型 ${v.model}`)
        if (asString(v.agent) !== '') meta.push(`代理 ${v.agent}`)
        if (asString(v.cwd) !== '') meta.push(`目录 ${v.cwd}`)
        if (Number.isFinite(v.durationMs)) meta.push(`耗时 ${Math.round(v.durationMs / 1000)}s`)
        if (meta.length > 0) lines.push(meta.join(' · '))
        if (v.rateLimited === true) lines.push('（上游限流，稍后重试或换模型）')
        const summary = asString(v.summary, '(无输出)')
        lines.push('', summary)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const input = isRecord(args) ? args : {}
      const settings = isRecord(resolveSettings()) ? resolveSettings() : {}

      const task = asString(input.task, '')
      if (task.length < TASK_MIN_LENGTH) {
        throw new Error(`task 太短或为空：请给出自包含的完整子任务指令（至少 ${TASK_MIN_LENGTH} 个字符）`)
      }

      const cli = asString(settings.opencodeCmd, CLI_DEFAULT)
      const agent = asString(input.agent, asString(settings.agent, AGENT_DEFAULT))
      // 工作目录优先级：调用参数 > 插件设置 > 会话工作区（exec 上下文）> 进程 cwd。
      // 不解析清楚会让 opencode 静默在 DSH 宿主进程目录里干活，改动落到意外位置。
      const cwd = asString(input.cwd, asString(settings.cwd, workspaceOf(exec)))
      const model = normalizeModel(input.model ?? settings.model)
      const timeoutMs = clampTimeout(input.timeoutMs ?? settings.timeoutMs)

      logger.info?.(`${name}: 分担任务 -> opencode (agent=${agent}, model=${model || 'default'}, cwd=${cwd || 'default'})`)

      const startedAt = Date.now()
      let outcome
      try {
        outcome = await runner({
          cli,
          task,
          model,
          agent,
          cwd,
          timeoutMs,
          signal: exec?.signal,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`opencode 分担失败：${message}`)
      }

      const durationMs = Date.now() - startedAt
      const parsed = extractResult(outcome.stdout)
      const stderrText = String(outcome.stderr ?? '').trim()

      // CLI 自己没输出可用事件（比如参数错、命令名错）时，把原始输出交回去便于定位。
      if (!parsed.sawJson && parsed.error === '') {
        const detail = clipOutput([stderrText, String(outcome.stdout ?? '').trim()].filter((t) => t !== '').join('\n'))
        throw new Error(`opencode 没有返回可解析的事件（exit ${outcome.code}）${detail !== '' ? `：\n${detail}` : ''}`)
      }

      const rateLimited = isRateLimited(parsed.error, parsed.status)
      const ok = outcome.code === 0 && parsed.error === ''

      let summary = parsed.text.trim()
      if (parsed.error !== '') {
        summary = clipOutput(`opencode 报错：${parsed.error}${stderrText !== '' ? `\n\n${stderrText}` : ''}`)
      } else if (summary === '') {
        summary = ok
          ? '(opencode 完成但没有输出正文，可能已直接改动文件；建议核对其改动结果)'
          : `(opencode 退出码 ${outcome.code}，无正文输出)${stderrText !== '' ? `\n${stderrText}` : ''}`
      } else {
        summary = clipOutput(summary)
      }

      const value = {
        ok,
        summary,
        model,
        agent,
        // 回报 opencode 真正的工作目录（空表示沿用宿主进程 cwd），
        // 否则「它到底在哪干的活」无从判断。
        cwd: cwd !== '' ? cwd : process.cwd(),
        exitCode: Number.isFinite(outcome.code) ? outcome.code : 0,
        durationMs,
        rateLimited,
      }

      logger.info?.(`${name}: opencode 分担结束 ok=${String(ok)} exit=${String(outcome.code)} 耗时=${String(Math.round(durationMs / 1000))}s`)
      return value
    },
  }
}

/** 读取插件设置（宿主把 config 合进 ctx 后由调用方给出）。 */
/**
 * 读取插件设置。
 *
 * 注意：这里**不能**直接写 `ctx.config`。cordis 的属性访问是受 inject 管控的，
 * 未把 'config' 列进 inject 就访问会抛
 * `cannot get property "config" without inject`（本机实测踩过）。
 * 本插件的配置全部可选，用 ctx.get('config') 做可选读取，拿不到就用空对象。
 */
function createSettingsResolver(ctx) {
  return () => {
    let raw
    try {
      raw = typeof ctx?.get === 'function' ? ctx.get('config') : ctx?.config
    } catch {
      raw = undefined
    }
    return isRecord(raw) ? raw : {}
  }
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 注册分担工具。宿主按 id `dsh-destinywind-ai-opencode` 加载本模块后调用 apply。
 * @param ctx cordis 插件上下文（已注入 tools 服务）。
 */
export function apply(ctx) {
  // logger 同样是注入管控属性，拿不到就退化成空实现（日志非关键路径）。
  let logger = { info() {}, warn() {}, error() {} }
  try {
    const candidate = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
    if (candidate !== undefined && candidate !== null) logger = candidate
  } catch {
    /* 保持空实现 */
  }
  const settings = createSettingsResolver(ctx)

  const definition = createDelegateTool({ resolveSettings: settings, logger })

  if (typeof ctx?.tools?.register !== 'function') {
    logger.warn?.(`${name}: tools 服务不可用，未注册 ${TOOL_NAME}`)
    return
  }

  ctx.tools.register(definition)
  logger.info?.(`${name}: 已注册工具 ${TOOL_NAME}（把子任务交给本机 opencode 执行）`)
}

export { TOOL_NAME, CLI_DEFAULT, AGENT_DEFAULT, TIMEOUT_DEFAULT_MS }
