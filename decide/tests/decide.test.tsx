import { expect, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const TOOL = 'mcp__decide__pending'
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const
const RUN = { command: 'decide', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as const
const ADD = [
  { question: '要不要改名 /prod-tune？', options: ['保持原名', '改为 /xray'], recommended: '保持原名：误选没有副作用', context: '8 次手打里 2 次误选了 /progress' },
  { question: '生产容器里能不能跑本地代码？' },
]

type World = {
  now: number
  store: Map<string, unknown>
  submitted: { text: string; asUser?: true }[]
  toasts: string[]
  commands: { name: string; immediate?: true }[]
  opened: { id: string; focus?: true; closeOnEscape?: true }[]
  panes: Set<string>
}

function world(on: On): World {
  const w: World = { now: 0, store: new Map(), submitted: [], toasts: [], commands: [], opened: [], panes: new Set() }
  on('ui.panes', () => ({ value: [...w.panes].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.open', ($, e) => {
    w.opened.push(e)
    w.panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    w.panes.delete(e.id)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: w.now }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('store.get', ($, e) => ({ value: w.store.get(e.key) }))
  on('store.set', ($, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('command.register', ($, e) => {
    w.commands.push(e)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => ({ value: { tool: `mcp__decide__${e.name}` } }))
  // 输入框上方原本什么都不画
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, {}) as RenderElement
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }))
  on('turn.complete', () => ({ text: '' }))
  return w
}

const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const BAND = { hasSurvey: false, isWorking: false } as never
const PANE = { title: '等你拍板', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 16 }, view: {} } as never
const REMIND = '2 项等你拍板 · /decide 回答：D1 要不要改名 /prod-tune？；D2 生产容器里能不能跑本地代码？'

test('登记两项：分到 D1、D2，右上角浮出提醒，存盘，结果列出全部待定', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  const ran = await $.tool.call({ tool: TOOL, add: ADD } as never)

  expect(ran.result).toBe('已登记 D1、D2。当前待定 2 项：D1 要不要改名 /prod-tune？；D2 生产容器里能不能跑本地代码？')
  expect(w.toasts).toEqual([REMIND])
  expect((w.store.get('session:s1') as { items: unknown[] }).items).toHaveLength(2)
})

test('每轮结束时还有待定项就再提醒一次；上一条提醒不到 20 秒、或没有待定项时不提醒', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.turn.complete(TURN)
  expect(w.toasts).toEqual([])

  w.now = 1000
  await $.tool.call({ tool: TOOL, add: ADD } as never)
  w.now = 15000
  await $.turn.complete(TURN)
  expect(w.toasts).toEqual([REMIND])

  w.now = 21000
  await $.turn.complete(TURN)
  expect(w.toasts).toEqual([REMIND, REMIND])
})

test('resolve 撤掉一项；全部撤掉后删掉存盘；不带参数只查看', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.tool.call({ tool: TOOL, add: ADD } as never)
  expect((await $.tool.call({ tool: TOOL, resolve: ['D1'] } as never)).result).toBe('当前待定 1 项：D2 生产容器里能不能跑本地代码？')
  expect((await $.tool.call({ tool: TOOL } as never)).result).toBe('当前待定 1 项：D2 生产容器里能不能跑本地代码？')
  expect((await $.tool.call({ tool: TOOL, resolve: ['D2'] } as never)).result).toBe('当前没有待定项。')
  expect(w.store.has('session:s1')).toBe(false)
})

test('会话重启后从存盘恢复，编号接着往下排', async ($, on) => {
  const w = world(on)
  w.store.set('session:s1', { seq: 5, items: [{ id: 'D5', question: '旧问题', options: [], recommended: '', context: '', choice: '', note: '' }] })
  await $.session.start(START)
  expect((await $.tool.call({ tool: TOOL, add: [{ question: '新问题' }] } as never)).result).toBe('已登记 D6。当前待定 2 项：D5 旧问题；D6 新问题')
})

test('系统提示末尾追加一段固定说明', async ($, on) => {
  world(on)
  const input = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: { name: 'default', isKeepingCodingInstructions: true }, traits: [] }
  const composed = await $.prompt.compose(input as never)
  expect(composed.sections.map(s => s.id)).toEqual(['base', 'decide'])
  expect(composed.sections[1]?.text).toContain('mcp__decide__pending')
})

test('/decide 没有待定项时只提示；有待定项时开一个拿着键盘、Esc 就关的面板，焦点在第一个选项，开着时输入框上方那一行不画；再输一次关掉；答完全部后面板自己关掉；Claude 回答中途也立刻执行', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.commands).toEqual([expect.objectContaining({ name: 'decide', immediate: true })])
  await $.command.run(RUN)
  expect(w.toasts).toEqual(['没有等你拍板的事'])
  expect(w.opened).toEqual([])

  await $.tool.call({ tool: TOOL, add: [ADD[0]] } as never)
  const band = await $.ui.mount({ plugin: 'decide', surface: 'terminal', component: 'AbovePrompt', requestId: 'b1', props: BAND })
  expect(await band.find({ text: '/decide 打开' })).toBeDefined()
  expect(await band.find({ text: /要不要改名/ })).toBeUndefined()

  await $.command.run(RUN)
  expect(w.opened).toEqual([expect.objectContaining({ id: 'decide', focus: true, closeOnEscape: true })])
  expect(await band.find({ text: /项等你拍板/ })).toBeUndefined()
  const pane = await $.ui.mount({ plugin: 'decide', surface: 'terminal', component: 'Pane', requestId: 'decide', props: PANE })
  expect(await pane.find({ text: '数字键选 · ↑↓ 移动 · Esc 关闭' })).toBeDefined()
  expect((await pane.find({ key: 'choice-D1-0' }))?.props).toMatchObject({ autoFocus: true, hotkey: '1' })

  // 再输一次 /decide 关掉面板，那一行回来
  await $.command.run(RUN)
  expect(w.panes.has('decide')).toBe(false)
  expect(await band.find({ text: '/decide 打开' })).toBeDefined()

  await $.command.run(RUN)
  await pane.press({ key: 'choice-D1-0' })
  await pane.press({ key: 'submit' })
  expect(w.submitted).toHaveLength(1)
  expect(w.panes.has('decide')).toBe(false)
})

for (const surface of SURFACES) {
  test(`面板里选一项、答一项再提交：选项带数字键，合成一条用户消息，已答的移出，未答的留下（${surface}）`, async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.tool.call({ tool: TOOL, add: [...ADD, { question: '第三个问题' }] } as never)
    await $.command.run(RUN)
    const ui = await $.ui.mount({ plugin: 'decide', surface, component: 'Pane', requestId: 'decide', props: PANE })

    expect(await ui.find({ text: '3 项等你拍板' })).toBeDefined()
    expect(await ui.find({ key: 'submit' })).toBeUndefined()
    expect(await ui.find({ text: '选一项或写了答复后才能提交' })).toBeDefined()

    // 选 B 再改选 A；再按一次已选的会取消，这里不按
    await ui.press({ key: 'choice-D1-1' })
    await ui.press({ key: 'choice-D1-0' })
    expect(await ui.find({ key: 'choice-D1-0', text: '● 保持原名' })).toBeDefined()
    expect(await ui.find({ key: 'choice-D1-1', text: '○ 改为 /xray' })).toBeDefined()
    await ui.input({ key: 'note-D2', text: '先不做，下次再说', kind: 'change' })
    // Enter 记下后答复还在
    await ui.input({ key: 'note-D2', text: '先不做，下次再说', kind: 'submit' })
    expect(await ui.find({ key: 'submit', text: '提交已答的 2 项' })).toBeDefined()
    await ui.press({ key: 'submit' })

    expect(w.submitted).toEqual([
      {
        text: '我在待定面板里对下面几项的答复（这几项已从面板移除，不用再 resolve）：\n1. D1 要不要改名 /prod-tune？ → 保持原名\n2. D2 生产容器里能不能跑本地代码？ → 先不做，下次再说',
        asUser: true,
      },
    ])
    expect((w.store.get('session:s1') as { items: { id: string }[] }).items.map(i => i.id)).toEqual(['D3'])
    expect(await ui.find({ text: 'D3 第三个问题' })).toBeDefined()
    expect(await ui.find({ text: /要不要改名/ })).toBeUndefined()
  })
}
