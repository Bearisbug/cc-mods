import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { DecideItem } from '../types'

const TOOL = 'mcp__decide__pending'
const REMIND_MS = 20000
const PANE = 'decide'
const ROWS = 16

const items = atom({ plugin: 'decide', key: 'items' } as const, [] as DecideItem[])

// 固定文本：整个会话不变，不破坏 prompt cache
const GUIDE = [
  '需要用户拍板的事项（只有用户能定、不能按推荐直接做的），除了照常写在回复里，还要调用 mcp__decide__pending 的 add 登记：',
  '每项一句问题，可选答案（推荐项放第一个），推荐哪个及理由，做决定需要的背景。',
  '用户会在「等你拍板」面板里回答，答复以一条用户消息发回。可逆、你已经按推荐做了的事不登记。',
  '用户在对话里直接答了某项，或某项已经不用定了，用同一工具的 resolve 传它的 id。不确定还有哪些待定时，不带参数调用它查看。',
].join('')

type Saved = { seq: number; items: DecideItem[] }
let seq = 0
// 上一次浮出提醒的时刻；同一插件的提醒会叠着显示，上一条还没消失就不再发
let remindedAt = -Infinity

const isAnswered = (item: DecideItem) => item.choice !== '' || item.note.trim() !== ''
const storeKey = async ($: EngineInterface) => `session:${await $.session.id()}`

async function change($: EngineInterface, fn: (list: DecideItem[]) => DecideItem[]): Promise<DecideItem[]> {
  const next = fn(await read($, items))
  await update($, items, () => next)
  const key = await storeKey($)
  if (next.length > 0) {
    await $.store.set(key, { seq, items: next } satisfies Saved)
  } else {
    await $.store.delete(key)
    await $.ui.close({ id: PANE })
  }
  return next
}

const paneOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function summary(list: DecideItem[]): string {
  if (list.length === 0) return '当前没有待定项。'
  return `当前待定 ${list.length} 项：${list.map(i => `${i.id} ${i.question}`).join('；')}`
}

function answerText(list: DecideItem[]): string {
  const lines = list.map((item, n) => {
    const parts = [item.choice, item.note.trim()].filter(Boolean)
    return `${n + 1}. ${item.id} ${item.question} → ${parts.join('；')}`
  })
  return ['我在待定面板里对下面几项的答复（这几项已从面板移除，不用再 resolve）：', ...lines].join('\n')
}

// 右上角浮出的提醒：最多显示三行，先写条数和怎么回答，问题放后面
async function remind($: EngineInterface): Promise<void> {
  const list = await read($, items)
  const now = await $.clock.now()
  if (list.length === 0 || now - remindedAt < REMIND_MS) return
  remindedAt = now
  const questions = list.map(i => `${i.id} ${i.question}`).join('；')
  $.ui.toast(`${list.length} 项等你拍板 · /decide 回答：${questions}`, { timeoutMs: REMIND_MS })
}

type Ui = Pick<ElementTable<'terminal'>, 'Box' | 'Text' | 'Button' | 'Input'>

function head({ Box, Text }: Ui, count: number, hint: string) {
  return (
    <Box flexDirection="row" gap={1}>
      <Text color="warning" bold>
        ▍待定
      </Text>
      <Text>{count} 项等你拍板</Text>
      <Text dimColor>{hint}</Text>
    </Box>
  )
}

// 面板里的整个列表
function sheet($: EngineInterface, ui: Ui, list: DecideItem[], hint: string) {
  const { Box, Text, Button, Input } = ui
  const answered = list.filter(isAnswered)
  const edit = (id: string, patch: Partial<DecideItem>) =>
    change($, current => current.map(i => (i.id === id ? { ...i, ...patch } : i)))
  // 选项按顺序配数字 1–9，0 是提交
  let digit = 0
  const hotkey = () => (++digit <= 9 ? String(digit) : undefined)
  return (
    <Box flexDirection="column">
      {head(ui, list.length, hint)}
      {list.map((item, n) => (
        <Box key={item.id} flexDirection="column" paddingLeft={2}>
          <Text bold>
            {item.id} {item.question}
          </Text>
          {item.context ? <Text dimColor>{item.context}</Text> : null}
          {item.recommended ? <Text color="success">推荐：{item.recommended}</Text> : null}
          {item.options.length > 0 ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {item.options.map((o, k) => (
                <Button
                  key={`choice-${item.id}-${k}`}
                  label={`${item.choice === o ? '●' : '○'} ${o}`}
                  hotkey={hotkey()}
                  plain
                  autoFocus={n === 0 && k === 0 ? true : undefined}
                  onPress={() => void edit(item.id, { choice: item.choice === o ? '' : o })}
                />
              ))}
            </Box>
          ) : null}
          <Box flexDirection="row" gap={2}>
            <Input
              key={`note-${item.id}`}
              label={item.options.length > 0 ? '补充' : '答复'}
              placeholder={item.options.length > 0 ? '可空' : '写你的答复'}
              value={item.note}
              submitLabel="记下"
              autoFocus={n === 0 && item.options.length === 0 ? true : undefined}
              onInput={value => void edit(item.id, { note: value })}
              // Enter 会清空输入框，引擎只在画出的值变了时才把值填回去：先置空再写回
              onSubmit={value => void edit(item.id, { note: '' }).then(() => edit(item.id, { note: value }))}
            />
            <Button key={`drop-${item.id}`} label="移除" plain dimColor onPress={() => void change($, c => c.filter(i => i.id !== item.id))} />
          </Box>
        </Box>
      ))}
      <Box paddingLeft={2}>
        {answered.length > 0 ? (
          <Button
            key="submit"
            label={`提交已答的 ${answered.length} 项`}
            hotkey="0"
            plain
            onPress={async () => {
              const done = (await read($, items)).filter(isAnswered)
              if (done.length === 0) return
              const ids = new Set(done.map(i => i.id))
              await change($, current => current.filter(i => !ids.has(i.id)))
              $.ui.toast(`已提交 ${done.length} 项，Claude 空闲后收到`)
              // Claude 回答中途提交时，submit 要等这一轮结束才返回；等它会超过按钮处理的 10 秒时限
              void $.prompt.submit({ text: answerText(done), asUser: true })
            }}
          />
        ) : (
          <Text dimColor>选一项或写了答复后才能提交</Text>
        )}
      </Box>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // immediate：Claude 回答中途输入也立刻开关，不排到这一轮结束
    await $.command.register({ name: 'decide', description: '打开 / 关闭「等你拍板」面板：选择、回答、提交待定事项', immediate: true })
    await $.tool.register({
      name: 'pending',
      description: `登记、撤销和查看等用户拍板的事项。${GUIDE}返回当前全部待定项及其 id。`,
      inputSchema: {
        type: 'object',
        properties: {
          add: {
            type: 'array',
            description: '要登记的待定项',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '一句话写清要用户定什么' },
                options: { type: 'array', items: { type: 'string' }, description: '可选答案，推荐项放第一个；开放问题可省略' },
                recommended: { type: 'string', description: '推荐哪个、为什么，一句话' },
                context: { type: 'string', description: '做决定需要知道的背景，一两句' },
              },
              required: ['question'],
            },
          },
          resolve: { type: 'array', items: { type: 'string' }, description: '不用再等的待定项 id' },
        },
      },
    })
    const saved = (await $.store.get(await storeKey($))) as Saved | undefined
    seq = saved?.seq ?? 0
    await update($, items, () => saved?.items ?? [])

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return { ...composed, sections: [...composed.sections, { id: 'decide', text: GUIDE, scope: 'session' }] }
  })

  on('tool.check', { tool: TOOL }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const added: DecideItem[] = (Array.isArray(args.add) ? args.add : [])
      .map(raw => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}))
      .filter(raw => text(raw.question) !== '')
      .map(raw => ({
        id: `D${++seq}`,
        question: text(raw.question),
        options: strings(raw.options),
        recommended: text(raw.recommended),
        context: text(raw.context),
        choice: '',
        note: '',
      }))
    const resolved = new Set(strings(args.resolve))
    const list = await change($, current => [...current.filter(i => !resolved.has(i.id)), ...added])
    if (added.length > 0) {
      await remind($)
    }
    const head = added.length > 0 ? `已登记 ${added.map(i => i.id).join('、')}。` : ''

    return { result: `${head}${summary(list)}` }
  })

  on('command.run', { command: 'decide' }, async $ => {
    if ((await read($, items)).length === 0) {
      $.ui.toast('没有等你拍板的事')
    } else if (await paneOpen($)) {
      await $.ui.close({ id: PANE })
    } else {
      // 面板拿着键盘：焦点落在第一个选项上，Esc 只关面板，不会中断 Claude
      await $.ui.open({ id: PANE, title: '等你拍板', focus: true, closeOnEscape: true, rows: ROWS })
      $.ui.invalidate('ui.render')
    }

    return {}
  })

  // 面板关掉后，输入框上方那一行重新画出来
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) $.ui.invalidate('ui.render')

    return closed
  })

  // 每轮结束时还有没答的就再提醒一次
  on('turn.complete', async ($, e, next) => {
    await remind($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const list = await read($, items)
    // 面板开着时列表在面板里，这一行先不画
    if (list.length === 0 || e.props.hasSurvey || e.surface === 'mobile' || (await paneOpen($))) return below
    const ui = $.ui.resolve(e)
    const { Box } = ui

    return (
      <Box flexDirection="column">
        {head(ui, list.length, '/decide 打开')}
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text>在对话里直接回答待定事项</Text>
    }

    return sheet($, $.ui.resolve(e), await read($, items), '数字键选 · ↑↓ 移动 · Esc 关闭')
  })
}
