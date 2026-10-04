import type { EngineInterface, Register, Timer } from 'claude-code'

type Api = EngineInterface
type Step = { title: string; signals: string[]; minutes: number }
type Item = Step & {
  status: 'done' | 'active' | 'todo'
  startedAt: number
  endedAt: number
  tools: number
  // 打勾时没有观察到它的起止（由 Claude 核对确认完成），不显示用时
  isUntimed: boolean
}
type Ending = 'running' | 'aborted' | 'paused' | 'done'
// 一个任务可以跨好几轮：被中断、或停下来问你之后，下一条消息接着同一份清单
type Task = {
  text: string
  activeMs: number
  segmentStart: number
  pausedAt: number
  ending: Ending
  tools: number
  items: Item[]
  isCurrentHit: boolean
  activity: string
  checkedAt: number
  calls: number
  firstEstimate: number
  isBusy: boolean
  isAsked: boolean
  isWaitingFirstReply: boolean
  // 正常收尾后等 Claude 核对的那几秒，显示「正在核对」而不是「已暂停」
  isFinalChecking: boolean
  // 这一轮执行过的工具调用（一行一条），估算时交给 Claude，免得把做完的步骤再列一遍
  trail: string[]
  timer: Timer | null
}
type Check = { isSameTask: boolean; done: number[]; current: number; add: Step[] }

const PLAN_AFTER_MS = 3 * 60_000
const CHECK_GAP_MS = 3 * 60_000
const TICK_MS = 15_000
const MAX_MODEL_CALLS = 6
const MAX_ITEMS = 10
const BAND_AFTER_MS = 60_000
const MINUTE = 60_000
const TOGGLE_KEY = 'ctrl+x p'
const PANE = 'steps'

// 所有步骤都可能出现的通用命令名，当关键词用会让每条命令都把清单往前推一格
const GENERIC_SIGNALS = new Set(['sleep', 'bash', 'sh', 'echo', 'cd', 'ls', 'cat', 'pwd', 'date', 'true', 'cp', 'mv', 'rm', 'mkdir', 'grep', 'find', 'sed', 'awk', 'git', 'npm', 'npx', 'node', 'python', 'python3', 'curl', 'read', 'edit', 'write'])

export function planPrompt(trail: string[]): string {
  const done = trail.length === 0 ? '（还没有执行任何工具调用）' : trail.map((c, i) => `${i + 1}. ${c}`).join('\n')
  return `这是一个旁路问题：只回答，不要调用任何工具。
这一轮到目前为止已经执行过的工具调用（按顺序）：
${done}

对照用户最近一条消息交代的任务和上面已经执行过的调用，估计完成这个任务还剩哪些步骤（正在执行的那一步算第一步；上面已经执行完的步骤不要再列）。只输出一个 JSON 对象，不要任何别的文字：
{"steps":[{"title":"不超过 14 个字的步骤名","signals":["做这一步时会出现在命令、文件路径或工具名里的 1 到 3 个关键词"],"minutes":预计分钟数}]}
关键词要能把这一步和别的步骤区分开：不要用 sleep、cd、ls、echo、cat、git、npm 这类每一步都可能出现的通用命令名。
minutes 按命令的真实耗时估，几十秒的步骤写 0.5 这样的小数。最多 8 步，按执行顺序。`
}

let task: Task | null = null
let bandUntil = 0
let bandTimer: Timer | null = null

export function parseSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return []
  return raw
    .flatMap(s => {
      const step = s as Partial<Step>
      if (typeof step.title !== 'string' || typeof step.minutes !== 'number') return []
      const signals = (Array.isArray(step.signals) ? step.signals : [])
        .filter((x): x is string => typeof x === 'string' && x.trim().length >= 2)
        .map(x => x.trim().toLowerCase())
        .filter(x => !GENERIC_SIGNALS.has(x))
      return [{ title: step.title.trim().slice(0, 24), signals, minutes: Math.max(0.5, step.minutes) }]
    })
    .slice(0, 8)
}

function jsonOf(text: string): Record<string, unknown> | null {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

export function parsePlan(text: string): Step[] {
  return parseSteps(jsonOf(text)?.steps)
}

export function checkPrompt(items: Item[], context: { newText?: string; answer?: string } = {}): string {
  const list = items.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
  const latest =
    context.newText === undefined
      ? ''
      : `\n用户刚发来的新消息是：「${context.newText}」。如果它是在接着或调整这份清单的任务，same_task 为 true；如果换成了另一件事，same_task 为 false。\n`
  const ended = context.answer === undefined ? '' : `\n这一轮已经结束，你最后的回复是：「${context.answer.slice(0, 400)}」。\n`
  return `这是一个旁路问题：只回答，不要调用任何工具。
这一轮任务的步骤清单如下（编号从 1 开始）：
${list}
${latest}${ended}
对照你到目前为止实际做过的工具调用和它们的结果，核对每一步：这一步要做的命令已经执行完、没有报错，就算完成；没有输出的命令（如 sleep、等待）执行完也算完成；还没执行或报错了的不算。只输出一个 JSON 对象，不要任何别的文字：
{"same_task":true,"done":[已完成的编号],"current":正在做或下一步要做的编号,"add":[{"title":"不超过 14 个字","signals":["1 到 3 个关键词"],"minutes":预计分钟数}]}
add 只列清单里没有、但完成任务还必须做的步骤，没有就给空数组。`
}

// 模型偶尔把编号写成字符串，或直接写步骤名：都按编号收下
function toIndex(v: unknown, titles: string[]): number {
  if (typeof v === 'number' && Number.isInteger(v)) return v
  if (typeof v !== 'string') return 0
  const n = Number(v.trim())
  if (Number.isInteger(n) && n > 0) return n
  return titles.indexOf(v.trim()) + 1
}

export function parseCheck(text: string, titles: string[] = []): Check | null {
  const raw = jsonOf(text)
  if (!raw) return null
  const done = (Array.isArray(raw.done) ? raw.done : []).map(v => toIndex(v, titles)).filter(n => n > 0)
  return {
    isSameTask: raw.same_task !== false && raw.same_task !== 'false',
    done,
    current: toIndex(raw.current, titles),
    add: parseSteps(raw.add),
  }
}

export function hitsStep(step: Step | undefined, haystack: string): boolean {
  const text = haystack.toLowerCase()
  return step?.signals.some(s => text.includes(s)) ?? false
}

// 只往前走一步：当前步骤已经被命中过（确实在做），而下一步的关键词出现了，当前步骤才打勾。
// 前后两步共用一个关键词时（连跑三次 sleep），当前步骤命中过以后再命中就算进入下一步。
export function stepAfter(cur: Step | undefined, nxt: Step | undefined, call: string, isCurrentHit: boolean): 'advance' | 'hit' | 'stay' {
  if (nxt && isCurrentHit && hitsStep(nxt, call)) return 'advance'
  if (hitsStep(cur, call)) return 'hit'
  return 'stay'
}

// pace：已完成步骤的实际用时 ÷ 预估用时，用来校准剩余步骤
export function remainingMinutes(plan: Step[], current: number, inStepMs: number, pace = 1): number {
  const step = plan[current]
  if (!step) return 0
  const later = plan.slice(current + 1).reduce((acc, s) => acc + s.minutes, 0)
  return Math.max(0, step.minutes * pace - inStepMs / MINUTE) + later * pace
}

// 预估时长：不到 1 分钟按秒，否则按整分钟
export function duration(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))} 秒`
  return `${Math.round(minutes)} 分`
}

// 实际用时：10 分钟以内精确到秒
export function spent(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} 秒`
  if (sec < 600) return sec % 60 === 0 ? `${sec / 60} 分` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
  return `${Math.round(sec / 60)} 分`
}

// 把一次工具调用压成一行「Claude 此刻在做什么」
export function describe(e: { tool: string; [key: string]: unknown }): string {
  const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)
  const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''
  if (e.tool === 'Bash') return `$ ${firstLine(str('command'))}`
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(e.tool)) return `${e.tool} ${base(str('file_path') || str('notebook_path'))}`
  if (e.tool === 'Grep' || e.tool === 'Glob') return `${e.tool} ${str('pattern')}`
  if (e.tool === 'Agent') return `子代理：${str('description')}`
  if (e.tool === 'WebFetch') return `WebFetch ${str('url')}`
  if (e.tool === 'WebSearch') return `WebSearch ${str('query')}`
  const mcp = /^mcp__(.+?)__(.+)$/.exec(e.tool)
  if (mcp) return `${mcp[1]}：${mcp[2]}`
  return e.tool
}

function taskTitle(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  if (line === '') return '（接着上一轮继续）'
  return [...line].length > 60 ? `${[...line].slice(0, 60).join('')}…` : line
}

function newTask(text: string): Task {
  return {
    text,
    activeMs: 0,
    segmentStart: Date.now(),
    pausedAt: 0,
    ending: 'running',
    tools: 0,
    items: [],
    isCurrentHit: false,
    activity: '',
    checkedAt: 0,
    calls: 0,
    firstEstimate: 0,
    isBusy: false,
    isAsked: false,
    isWaitingFirstReply: false,
    isFinalChecking: false,
    trail: [],
    timer: null,
  }
}

function elapsed(t: Task, now: number): number {
  return t.activeMs + (t.segmentStart > 0 ? now - t.segmentStart : 0)
}

function active(t: Task): number {
  return t.items.findIndex(i => i.status === 'active')
}

function isAllDone(t: Task): boolean {
  return t.items.length > 0 && t.items.every(i => i.status === 'done')
}

function pace(t: Task): number {
  const timed = t.items.filter(i => i.status === 'done' && !i.isUntimed)
  const planned = timed.reduce((acc, i) => acc + i.minutes, 0)
  if (planned === 0) return 1
  const actual = timed.reduce((acc, i) => acc + (i.endedAt - i.startedAt), 0) / MINUTE
  return Math.min(5, Math.max(0.1, actual / planned))
}

function left(t: Task, now: number): number {
  const at = active(t)
  const cur = t.items[at]
  if (!cur) return 0
  return remainingMinutes(t.items, at, now - cur.startedAt, pace(t))
}

function bar(done: number, total: number, cells = 8): string {
  const filled = total > 0 ? Math.min(cells, Math.round((done / total) * cells)) : 0
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

function isRunningVisible(t: Task, now: number): boolean {
  return t.isAsked || t.items.length > 0 || t.isBusy || elapsed(t, now) >= PLAN_AFTER_MS
}

function redraw($: Api) {
  $.ui.invalidate('ui.render')
}

function item(step: Step, status: Item['status'], now: number): Item {
  return { ...step, status, startedAt: status === 'active' ? now : 0, endedAt: 0, tools: 0, isUntimed: false }
}

async function ask($: Api, t: Task, prompt: string): Promise<string | null> {
  if (t.isBusy || t.calls >= MAX_MODEL_CALLS) return null
  t.isBusy = true
  redraw($)
  const reply = await $.model.fork({ prompt }).catch(() => undefined)
  t.isBusy = false
  // 新会话第一条回复出来之前没有可分叉的对话：不算一次调用，稍后自动重试
  t.isWaitingFirstReply = reply !== undefined && !reply.isAnswered && reply.reason === 'nothing-to-fork'
  if (!t.isWaitingFirstReply) {
    t.calls += 1
    t.checkedAt = Date.now()
  }
  return reply?.isAnswered ? reply.text : null
}

// 上一个模型调用还没回来时先等一等，而不是直接跳过（正常收尾的核对不能丢）
function whenIdle($: Api, t: Task, run: () => void, tries = 20) {
  if (task !== t) return
  if (t.isBusy && tries > 0) {
    $.clock.after(3000, () => whenIdle($, t, run, tries - 1))
    return
  }
  run()
}

// 第一次：没有清单时估算一份
async function estimate($: Api, t: Task) {
  const text = await ask($, t, planPrompt(t.trail))
  const steps = text ? parsePlan(text) : []
  if (task === t && steps.length > 0 && t.items.length === 0) {
    const now = Date.now()
    t.items = steps.map((s, n) => item(s, n === 0 ? 'active' : 'todo', now))
    // 估算约定「正在执行的那一步算第一步」：已经有工具调用时，第一步就算在做了
    t.isCurrentHit = t.tools > 0
    t.firstEstimate = Math.round(elapsed(t, now) / MINUTE + steps.reduce((acc, s) => acc + s.minutes, 0))
  }
  redraw($)
}

// 之后：不再重估，只请 Claude 核对现有清单——哪些真的做完了、正在做哪步、要不要补步骤
async function check($: Api, t: Task, context: { newText?: string; answer?: string } = {}) {
  if (t.items.length === 0) return
  const newText = context.newText
  const text = await ask($, t, checkPrompt(t.items, context))
  const result = text ? parseCheck(text, t.items.map(i => i.title)) : null
  if (task !== t || !result) {
    redraw($)
    return
  }
  if (!result.isSameTask && newText !== undefined) {
    const fresh = newTask(newText)
    fresh.timer = t.timer
    task = fresh
    void estimate($, fresh)
    return
  }
  applyCheck(t, result, Date.now())
  redraw($)
}

export function applyCheck(t: { items: Item[]; isCurrentHit: boolean }, result: Check, now: number) {
  const done = new Set(result.done.map(n => n - 1))
  const added = result.add.slice(0, Math.max(0, MAX_ITEMS - t.items.length)).map(s => item(s, 'todo', now))
  t.items.push(...added)
  t.items.forEach((it, i) => {
    if (done.has(i)) {
      if (it.status === 'active') Object.assign(it, { status: 'done', endedAt: now })
      else if (it.status === 'todo') Object.assign(it, { status: 'done', startedAt: now, endedAt: now, isUntimed: true })
    } else if (it.status === 'done') {
      Object.assign(it, { status: 'todo', startedAt: 0, endedAt: 0, isUntimed: false })
    }
  })
  const wanted = result.current - 1
  const target = t.items[wanted] && t.items[wanted].status !== 'done' ? wanted : t.items.findIndex(i => i.status !== 'done')
  const previous = active(t as Task)
  t.items.forEach((it, i) => {
    if (it.status === 'done') return
    if (i === target) {
      if (it.status !== 'active') Object.assign(it, { status: 'active', startedAt: now })
    } else if (it.status === 'active') {
      Object.assign(it, { status: 'todo', startedAt: 0 })
    }
  })
  if (target !== previous) t.isCurrentHit = false
}

function tick($: Api) {
  const t = task
  if (!t || t.ending !== 'running') return
  const now = Date.now()
  const cur = t.items[active(t)]
  if (t.items.length === 0 && (t.isAsked || elapsed(t, now) >= PLAN_AFTER_MS)) {
    void estimate($, t)
  } else if (cur && now - t.checkedAt >= CHECK_GAP_MS && now - cur.startedAt > Math.max(2 * MINUTE, cur.minutes * 2 * MINUTE)) {
    void check($, t)
  }
  if (isRunningVisible(t, now)) redraw($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'steps',
      description: '打开或关闭任务步骤面板（快捷键 ctrl+x p）',
      immediate: true,
    })
    return next(e)
  })

  // 清单放在拿键盘焦点的面板里：Claude 工作时按 Esc 先关面板，不会打到「中断本轮」上
  on('command.run', { command: 'steps' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return {}
    }
    const t = task
    if (t && t.ending === 'running') {
      t.isAsked = true
      if (t.items.length === 0) void estimate($, t)
    }
    await $.ui.open({ id: PANE, title: '任务步骤', focus: true, closeOnEscape: true, rows: Math.max(t?.items.length ?? 0, 4) + 8 })
    redraw($)
    return {}
  })

  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    bandTimer?.cancel()
    bandUntil = 0
    const now = Date.now()
    const prev = task
    if (prev && prev.ending !== 'running' && prev.items.length > 0 && !isAllDone(prev)) {
      // 上一轮没做完（被中断或停下来问你）：接着同一份清单，空闲时间不计入
      const cur = prev.items[active(prev)]
      if (cur) cur.startedAt += now - prev.pausedAt
      prev.segmentStart = now
      prev.ending = 'running'
      prev.isFinalChecking = false
      prev.timer = $.clock.every(TICK_MS, () => tick($))
      whenIdle($, prev, () => void check($, prev, { newText: e.text }))
    } else {
      prev?.timer?.cancel()
      task = newTask(e.text)
      task.timer = $.clock.every(TICK_MS, () => tick($))
    }
    redraw($)
    return started
  })

  on('tool.call', ($, e, next) => {
    const t = task
    if (t && t.ending === 'running' && e.agentId === undefined) {
      const now = Date.now()
      t.tools += 1
      t.activity = describe(e)
      t.trail = [...t.trail, t.activity].slice(-30)
      const at = active(t)
      const cur = t.items[at]
      const nxt = t.items[at + 1]
      const move = stepAfter(cur, nxt, JSON.stringify(e), t.isCurrentHit)
      if (move === 'advance' && cur && nxt) {
        Object.assign(cur, { status: 'done', endedAt: now })
        Object.assign(nxt, { status: 'active', startedAt: now })
      } else if (move === 'hit') {
        t.isCurrentHit = true
      }
      const now2 = t.items[active(t)]
      if (now2) now2.tools += 1
      if (t.items.length === 0 && t.isWaitingFirstReply && !t.isBusy) void estimate($, t)
      redraw($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const t = task
    if (e.agentId === undefined && t && t.ending === 'running') {
      const now = Date.now()
      t.timer?.cancel()
      t.timer = null
      t.activeMs += now - t.segmentStart
      t.segmentStart = 0
      t.pausedAt = now
      t.ending = e.isAborted ? 'aborted' : 'paused'
      if (t.items.length > 0) {
        bandUntil = now + BAND_AFTER_MS
        bandTimer = $.clock.after(BAND_AFTER_MS, () => redraw($))
        if (!e.isAborted) {
          // 正常结束时核对一次，清单如实反映哪些做完了
          const answer = e.answer
          t.isFinalChecking = true
          whenIdle($, t, () =>
            void check($, t, { answer }).then(() => {
              t.isFinalChecking = false
              if (task === t && t.ending === 'paused' && isAllDone(t)) t.ending = 'done'
              redraw($)
            }),
          )
        }
      }
      redraw($)
    }
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const now = Date.now()
    const t = task
    if (!t || e.props.hasSurvey) return below
    const isRunning = t.ending === 'running'
    if (isRunning ? !isRunningVisible(t, now) : now >= bandUntil) return below
    const { Box, Text } = $.ui.resolve(e)
    const at = active(t)
    const cur = t.items[at]
    const doneCount = t.items.filter(i => i.status === 'done').length

    let body
    if (!isRunning) {
      const word = t.isFinalChecking ? '正在核对…' : t.ending === 'done' ? '任务完成' : t.ending === 'aborted' ? '已中断' : '已暂停'
      const tail = t.isFinalChecking
        ? `Claude 在确认哪些步骤真的做完了 · 已打勾 ${doneCount}/${t.items.length}`
        : t.ending === 'done'
          ? `用时 ${spent(elapsed(t, now))}`
          : `完成 ${doneCount}/${t.items.length} 步 · 下一条消息接着这份清单`
      body = [
        <Text key="word">{word}</Text>,
        <Text key="tail" dimColor>
          {tail} · {TOGGLE_KEY} 看步骤
        </Text>,
      ]
    } else if (!cur) {
      body = [
        <Text key="state">{t.isBusy ? '正在估算步骤…' : t.isWaitingFirstReply ? '等 Claude 第一次回复后估算' : '还没有步骤估算'}</Text>,
        <Text key="meta" dimColor>
          已 {spent(elapsed(t, now))} · {t.tools} 次工具调用 · {TOGGLE_KEY} 看步骤
        </Text>,
      ]
    } else {
      const remain = left(t, now)
      const nextItem = t.items[at + 1]
      body = [
        <Text key="step">
          {at + 1}/{t.items.length} {cur.title}
        </Text>,
        <Text key="bar" color="autoAccept">
          {bar(doneCount, t.items.length)}
        </Text>,
        <Text key="meta" dimColor>
          已 {spent(elapsed(t, now))} · {remain > 0 ? `约剩 ${duration(remain)}` : '已超出预估'}
          {nextItem ? ` · 下一步 ${nextItem.title}` : ''} · {TOGGLE_KEY} 看步骤
        </Text>,
      ]
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="autoAccept" bold>
            ▍进度
          </Text>
          {body}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()
    const t = task
    const width = Math.max(40, e.props.bodyColumns - 2)
    const titleWidth = Math.min(30, Math.max(14, Math.floor(width * 0.4)))

    const footer = (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>✓ 只在下一步真正开始、或 Claude 核对确认后才打勾；中断后发下一条消息，接着这份清单，不重新估算。</Text>
        <Text dimColor>Esc 或 {TOGGLE_KEY} 关闭（面板开着时 Esc 只关面板，不会中断 Claude）</Text>
      </Box>
    )
    if (!t) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text>还没有任务记录。Claude 开始干活后，这里会显示步骤。</Text>
          {footer}
        </Box>
      )
    }

    const at = active(t)
    const doneCount = t.items.filter(i => i.status === 'done').length
    const parts = [`已 ${spent(elapsed(t, now))}`]
    if (t.ending === 'running') {
      if (at >= 0) parts.push(left(t, now) > 0 ? `约剩 ${duration(left(t, now))}` : '已超出预估', `第 ${at + 1}/${t.items.length} 步`)
      else parts.push(`${t.tools} 次工具调用`)
      if (t.isBusy && t.items.length > 0) parts.push('Claude 正在核对进度…')
    } else {
      parts.unshift(t.isFinalChecking ? '正在核对…' : t.ending === 'done' ? '任务完成' : t.ending === 'aborted' ? '已中断' : '已暂停')
      parts.push(`完成 ${doneCount}/${t.items.length} 步`)
      if (t.ending !== 'done' && !t.isFinalChecking) parts.push('下一条消息接着这份清单')
    }

    const stepRow = (it: Item, n: number) => {
      const isNow = it.status === 'active'
      const isLive = isNow && t.ending === 'running'
      const mark = it.status === 'done' ? '✓' : isNow ? '▶' : '○'
      const markColor = it.status === 'done' ? 'success' : isNow ? 'autoAccept' : undefined
      const inStep = (t.ending === 'running' ? now : t.pausedAt) - it.startedAt
      const calls = it.tools > 0 ? ` · ${it.tools} 次调用` : ''
      let note
      if (it.status === 'done') note = it.isUntimed ? '已完成（Claude 核对确认）' : `${spent(it.endedAt - it.startedAt)}（预计 ${duration(it.minutes)}）${calls}`
      else if (isNow) note = `${spent(inStep)} / 预计 ${duration(it.minutes)}${calls}${isLive ? '' : ' · 已暂停'}`
      else note = `预计 ${duration(it.minutes)}`
      return (
        <Box flexDirection="column" key={`step-${n}`}>
          <Box flexDirection="row" gap={1}>
            <Text color={markColor} bold={isNow}>
              {mark}
            </Text>
            <Box width={2}>
              <Text dimColor={!isNow}>{String(n + 1)}</Text>
            </Box>
            <Box width={titleWidth}>
              <Text bold={isNow} dimColor={it.status === 'done'}>
                {it.title}
              </Text>
            </Box>
            {isNow && <Text color="autoAccept">{bar(inStep, it.minutes * MINUTE, 5)}</Text>}
            <Text dimColor>{note}</Text>
          </Box>
          {isLive && t.activity !== '' && (
            <Box paddingLeft={5}>
              <Text color="ide">└ {t.activity}</Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" gap={1}>
          <Text color="autoAccept" bold>
            任务
          </Text>
          <Text>{taskTitle(t.text)}</Text>
        </Box>
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text dimColor>{parts.join(' · ')}</Text>
          {t.items.length > 0 && <Text color="autoAccept">{bar(doneCount, t.items.length)}</Text>}
        </Box>
        {t.items.map(stepRow)}
        {t.items.length === 0 && (
          <Box flexDirection="column">
            <Text dimColor>
              {t.isBusy
                ? '正在估算步骤，几秒后出现清单…'
                : t.isWaitingFirstReply
                  ? '等 Claude 第一次回复后估算'
                  : '还没有步骤估算（跑满 3 分钟或按 ctrl+x p 时估算）'}
            </Text>
            {t.ending === 'running' && t.activity !== '' && <Text color="ide">└ {t.activity}</Text>}
          </Box>
        )}
        {footer}
      </Box>
    )
  })
}
