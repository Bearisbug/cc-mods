import { expect, test } from 'claude-code/testing'
import type { FsEntry, On, RenderElement } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const GROUPS = '改代码: trim /ship; 线上: triage'
const RUN = { command: 'cmds', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 146 } } as const
const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

const md = (description: string, hint = '') =>
  `---\ndescription: ${description}\n${hint ? `argument-hint: ${hint}\n` : ''}---\n\n正文 $ARGUMENTS\n`

// 用户级命令目录里三个文件（一个是软链）加一个非 .md 文件，项目目录里一个同名覆盖、一个新命令
const FILES: Record<string, string> = {
  '/home/u/.claude/commands/trim.md': md('精简代码：外部行为不变，只让代码变少', '[路径]'),
  '/home/u/.claude/commands/ship.md': md('自查 diff → commit → push（无署名；直接提交当前分支）'),
  '/home/u/.claude/commands/wf.md': md('派 Workflow 做一件事（调研 / 评审）：主会话切块', '<任务>'),
  '/work/.claude/commands/wf.md': md('项目自己的 wf：只在这个仓库用'),
  '/work/.claude/commands/triage.md': md('从一条反馈排查线上问题：先止血'),
}
const DIRS: Record<string, FsEntry[]> = {
  '/home/u/.claude/commands': [
    { name: 'trim.md', kind: 'other', size: 0, mtimeMs: 0, isLink: true },
    { name: 'ship.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: 'wf.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: 'notes.txt', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
  ],
  '/work/.claude/commands': [
    { name: 'wf.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    { name: 'triage.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
  ],
}

function world(on: On) {
  const commands: { name: string; immediate?: true }[] = []
  const opened: { id: string; focus?: true; closeOnEscape?: true }[] = []
  const panes = new Set<string>()
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.open', ($, e) => {
    opened.push(e)
    panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)
    return { value: undefined }
  })
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.list', ($, e) => {
    const entries = DIRS[e.path]
    if (!entries) throw new Error(`ENOENT ${e.path}`)
    return { value: entries }
  })
  on('fs.read', ($, e) => ({ value: FILES[e.path] ?? '' }))
  on('command.register', ($, e) => {
    commands.push(e)
    return { value: { command: e.name } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  return { commands, opened, panes }
}

const PANE = { title: '短命令', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 16 }, view: {} } as never

test('/cmds 开一个拿着键盘、Esc 就关的面板，再输一次关掉；Claude 回答中途也立刻执行', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(w.commands).toEqual([expect.objectContaining({ name: 'cmds', immediate: true })])

  await $.command.run(RUN)
  expect(w.opened).toEqual([expect.objectContaining({ id: 'cmds', focus: true, closeOnEscape: true })])
  const pane = await $.ui.mount({ plugin: 'cmds', surface: 'terminal', component: 'Pane', requestId: 'cmds', props: PANE })
  expect(await pane.find({ text: '全部命令' })).toBeDefined()
  expect(await pane.find({ text: '↑↓ 滚动 · Esc 关闭' })).toBeDefined()

  await $.command.run(RUN)
  expect(w.panes.has('cmds')).toBe(false)
})

for (const surface of SURFACES) {
  test(`按配置分组，没配进组的排在「其他」，项目命令覆盖同名（${surface}）`, { options: { groups: GROUPS } }, async ($, on) => {
    world(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'cmds', surface, component: 'Pane', requestId: 'cmds', props: PANE })

    const titles = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(titles.indexOf('改代码')).toBeLessThan(titles.indexOf('线上'))
    expect(titles.indexOf('线上')).toBeLessThan(titles.indexOf('其他'))
    expect(await ui.find({ text: '/trim [路径]' })).toBeDefined()
    expect(await ui.find({ text: '精简代码' })).toBeDefined()
    expect(await ui.find({ text: '外部行为不变' })).toBeUndefined()
    expect(await ui.find({ text: '自查 diff → commit → push（无署名；直接提交当前分支）' })).toBeDefined()
    expect(await ui.find({ text: '项目自己的 wf' })).toBeDefined()
    expect(await ui.find({ text: '派 Workflow' })).toBeUndefined()
    expect(await ui.find({ text: '/notes' })).toBeUndefined()
  })

  test(`没配分组时全部排成一组（${surface}）`, async ($, on) => {
    world(on)
    await $.session.start(START)
    const ui = await $.ui.mount({ plugin: 'cmds', surface, component: 'Pane', requestId: 'cmds', props: PANE })

    expect(await ui.find({ text: '全部命令' })).toBeDefined()
    expect(await ui.find({ text: '其他' })).toBeUndefined()
    for (const name of ['ship', 'trim', 'triage', 'wf']) expect(await ui.find({ text: `/${name}` })).toBeDefined()
  })

  test(`提示行空闲时按分组顺序轮换，输入中不加（${surface}）`, { options: { groups: GROUPS } }, async ($, on) => {
    world(on)
    const tails: Record<string, (string | undefined)[]> = {}
    on('ui.render', { component: 'PromptHint' }, ($, e) => {
      ;(tails[e.requestId] ??= []).push(e.props.tail)
      const { Text } = $.ui.resolve(e)
      return h(Text, {}, e.props.hint) as RenderElement
    })
    await $.session.start(START)
    const idle = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

    await $.ui.mount({ plugin: 'cmds', surface, component: 'PromptHint', requestId: 'before', props: idle })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.ui.mount({ plugin: 'cmds', surface, component: 'PromptHint', requestId: 'after', props: idle })
    await $.ui.mount({ plugin: 'cmds', surface, component: 'PromptHint', requestId: 'draft', props: { ...idle, isDraft: true } })

    expect(tails.before?.[0]).toBe('/trim 精简代码 · /cmds 看全部')
    expect(tails.after?.[0]).toBe('/ship 自查 diff → commit → push（无署名；直接提交当前分支） · /cmds 看全部')
    expect(tails.draft).toEqual([undefined])
  })
}
