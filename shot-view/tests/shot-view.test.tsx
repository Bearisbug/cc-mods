import { describe, expect, mock, test } from 'claude-code/testing'

import { findPngPaths, resolvePath } from '../hooks/register'

describe('findPngPaths', () => {
  test('finds absolute, relative and home paths once each', () => {
    const text = 'saved /tmp/a.png and ./shots/b.PNG, again /tmp/a.png; ~/Desktop/c.png'
    expect(findPngPaths(text)).toEqual(['/tmp/a.png', './shots/b.PNG', '~/Desktop/c.png'])
  })

  test('ignores other image types', () => {
    expect(findPngPaths('photo.jpg cover.webp')).toEqual([])
  })
})

test('resolvePath', () => {
  expect(resolvePath('/w/app', './shots/../b.png', '/Users/x')).toBe('/w/app/b.png')
  expect(resolvePath('/w/app', '~/Desktop/c.png', '/Users/x')).toBe('/Users/x/Desktop/c.png')
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const PANE_PROPS = {
  title: '截图',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('a screenshot taken by Bash shows in the pane, and the pane pages back', async ($, on) => {
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('env.get', () => ({ value: '/Users/x' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: Date.now(), isLink: false } }))
  on('process.run', ($, e) => ok(e.argv[0] === 'sips' ? 'pixelWidth: 1290\n  pixelHeight: 2796\n' : ''))
  const open = new Set<string>()
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  // 另一个插件在同一条带里画的一行，用来确认几行能叠在一起
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other mod</Text>
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'Wrote screenshot to shots/home.png' }))

  await $.tool.call({ tool: 'Bash', command: 'xcrun simctl io booted screenshot shots/old.png' })
  await $.tool.call({ tool: 'Bash', command: 'xcrun simctl io booted screenshot shots/home.png' })
  const band = await $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ text: '新增 home.png' })).toBeDefined()
  expect(await band.find({ text: 'other mod' })).toBeDefined()

  await $.command.run({ command: 'shots', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })
  expect(await band.find({ text: '新增 home.png' })).toBeUndefined()
  expect(await band.find({ text: 'other mod' })).toBeDefined()
  expect(open.has('shots')).toBe(true)
  await $.command.run({ command: 'shots', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })
  expect(open.has('shots')).toBe(false)
  await band.unmount()

  const ui = await $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'Pane', requestId: 'shots', props: PANE_PROPS })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.source).toMatchObject({ file: '/w/shots/home.png', format: 'png' })
  expect(await ui.find({ text: '1/2' })).toBeDefined()

  // 面板从最新一张开始，n 往后看更早的那张，p 回来
  await ui.press({ key: 'next' })
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: '/w/shots/old.png', format: 'png' })
  await ui.press({ key: 'prev' })
  expect((await ui.find({ type: 'Image' }))?.props.source).toMatchObject({ file: '/w/shots/home.png', format: 'png' })
  await ui.unmount()

  const desktop = await $.ui.mount({ plugin: 'shot-view', surface: 'desktop', component: 'Pane', requestId: 'shots', props: PANE_PROPS })
  expect(await desktop.find({ text: /终端没有开启图片显示/ })).toBeDefined()
  await desktop.unmount()
})

test('r marks a shot read so it leaves the pane, u brings it back, an unchanged file stays read, a rewritten one is unread again', async ($, on) => {
  const base = Date.now()
  const mtimes: Record<string, number> = { '/w/a.png': base, '/w/b.png': base }
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('env.get', () => ({ value: '/Users/x' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file' as const, size: 10, mtimeMs: mtimes[e.path] ?? base, isLink: false } }))
  on('process.run', () => ok('pixelWidth: 1280\n  pixelHeight: 860\n'))
  on('ui.panes', () => ({ value: [] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  const shoot = (name: string) => $.tool.call({ tool: 'Bash', command: `screencapture ${name}` })
  const image = async (ui: { find: (q: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) =>
    ((await ui.find({ type: 'Image' }))?.props.source as { file: string } | undefined)?.file

  await shoot('a.png')
  await shoot('b.png')
  const pane = await $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'Pane', requestId: 'shots', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: /未读 1\/2/ })).toBeDefined()
  expect(await image(pane)).toBe('/w/b.png')

  // 只是翻过不算已读
  await pane.press({ key: 'next' })
  await pane.press({ key: 'prev' })
  expect(await pane.find({ type: 'Text', text: /未读 1\/2/ })).toBeDefined()

  await pane.press({ key: 'read' })
  expect(await image(pane)).toBe('/w/a.png')
  expect(await pane.find({ type: 'Text', text: /未读 1\/1/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /已读 1/ })).toBeDefined()

  await pane.press({ key: 'read' })
  expect(await pane.find({ type: 'Text', text: '截图都看完了' })).toBeDefined()
  expect(await pane.find({ type: 'Image' })).toBeUndefined()

  await pane.press({ key: 'undo' })
  expect(await image(pane)).toBe('/w/a.png')

  // Claude 又读了一遍没改过的 b.png：仍是已读
  await $.tool.call({ tool: 'Read', file_path: '/w/b.png' })
  expect(await pane.find({ type: 'Text', text: /未读 1\/1/ })).toBeDefined()

  // b.png 被新截图覆盖：算新的，回到未读
  mtimes['/w/b.png'] = base + 5_000
  await shoot('b.png')
  expect(await image(pane)).toBe('/w/b.png')
  expect(await pane.find({ type: 'Text', text: /未读 1\/2/ })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Text', text: '未读 2 张 · ctrl+x s 查看' })).toBeDefined()
  await band.unmount()
})

test('a deleted file leaves the pane instead of drawing a black box; an overwritten one is re-read; the picture fits the pane', async ($, on) => {
  const base = Date.now()
  const files: Record<string, number | undefined> = { '/w/a.png': base, '/w/b.png': base, '/w/c.png': base }
  const ok = (stdout: string) => ({
    value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })
  on('env.get', () => ({ value: '/Users/x' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.stat', ($, e) => {
    const mtimeMs = files[e.path]
    return mtimeMs === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file' as const, size: 10, mtimeMs, isLink: false } }
  })
  on('process.run', () => ok('pixelWidth: 1290\n  pixelHeight: 2796\n'))
  on('ui.panes', () => ({ value: [] }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  for (const name of ['a.png', 'b.png', 'c.png']) await $.tool.call({ tool: 'Bash', command: `screencapture ${name}` })
  const props = { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 20 } }
  const mount = () => $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'Pane', requestId: 'shots', props })
  const source = async (ui: Awaited<ReturnType<typeof mount>>) =>
    (await ui.find({ type: 'Image' }))?.props as { source: { file: string; generation?: number }; rows: number } | undefined

  // c.png 被删掉：不画黑框，跳到下一张还在的，并说明少了一张
  files['/w/c.png'] = undefined
  let pane = await mount()
  expect((await source(pane))?.source.file).toBe('/w/b.png')
  expect(await pane.find({ type: 'Text', text: /未读 1\/2/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /另有 1 张截图的文件已不在/ })).toBeDefined()
  // 竖长图按面板可见高度缩：20 行减去按键、说明和提示
  expect((await source(pane))?.rows).toBeLessThanOrEqual(11)
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  expect(await band.find({ type: 'Text', text: '未读 2 张 · ctrl+x s 查看' })).toBeDefined()
  await band.unmount()

  // b.png 被原地覆盖：把新的修改时间交给终端，让它重新读
  files['/w/b.png'] = base + 7_000
  pane = await mount()
  expect((await source(pane))?.source.generation).toBe(Math.floor(base + 7_000))
  await pane.unmount()

  // 全都没了：说清楚，而不是空着
  files['/w/a.png'] = undefined
  files['/w/b.png'] = undefined
  pane = await mount()
  expect(await pane.find({ type: 'Image' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '没有可看的截图' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /另有 3 张截图的文件已不在/ })).toBeDefined()
  await pane.unmount()
})

describe('o: hold to enlarge in the terminal, tap for Quick Look', () => {
  const setup = (on: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const runs: string[][] = []
    const opens: { columns?: number }[] = []
    on('env.get', () => ({ value: '/Users/x' }))
    on('session.cwd', () => ({ value: '/w' }))
    on('fs.stat', () => ({ value: { kind: 'file' as const, size: 10, mtimeMs: Date.now(), isLink: false } }))
    on('process.run', ($, e) => {
      runs.push([...e.argv])
      return { value: { exitCode: 0, stdout: 'pixelWidth: 1280\n  pixelHeight: 860\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.panes', () => ({ value: [] }))
    on('ui.open', ($, e) => {
      opens.push({ columns: e.columns })
      return { value: { isPlaced: true as const } }
    })
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
    return { clock, runs, opens }
  }
  const props = { ...PANE_PROPS, bodyColumns: 50, scroll: { offset: 0, bodyRows: 30 } }
  const viewport = { columns: 160, rows: 40, isFullscreen: true }

  test('holding o (repeated presses) enlarges the picture; when the repeats stop it goes back', async ($, on) => {
    const { clock, runs, opens } = setup(on)
    await $.tool.call({ tool: 'Bash', command: 'screencapture /w/a.png' })
    const pane = await $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'Pane', requestId: 'shots', props, viewport })
    const opensBefore = opens.length
    const normalRows = ((await pane.find({ type: 'Image' }))?.props.rows as number) ?? 0

    await pane.press({ key: 'peek' })
    await clock.advance(300)
    await pane.press({ key: 'peek' })
    for (let i = 0; i < 6; i++) {
      await clock.advance(60)
      await pane.press({ key: 'peek' })
    }
    expect(await pane.find({ key: 'peek', text: /松开 o 回到列表/ })).toBeDefined()
    expect(((await pane.find({ type: 'Image' }))?.props.rows as number) ?? 0).toBeGreaterThan(normalRows)

    await clock.advance(400)
    expect(await pane.find({ key: 'peek', text: /松开 o 回到列表/ })).toBeUndefined()
    expect(await pane.find({ key: 'next' })).toBeDefined()
    expect(runs.some(r => r[0] === 'qlmanage')).toBe(false)
    // 放大只在面板里做，不重新 open 面板、不改宽度
    expect(opens.length).toBe(opensBefore)
    await pane.unmount()
  })

  test('a single tap of o opens macOS Quick Look and leaves the pane as it was', async ($, on) => {
    const { clock, runs } = setup(on)
    await $.tool.call({ tool: 'Bash', command: 'screencapture /w/a.png' })
    const pane = await $.ui.mount({ plugin: 'shot-view', surface: 'terminal', component: 'Pane', requestId: 'shots', props, viewport })
    await pane.press({ key: 'peek' })
    expect(runs.some(r => r[0] === 'qlmanage')).toBe(false)
    await clock.advance(600)
    expect(runs.find(r => r[0] === 'qlmanage')).toEqual(['qlmanage', '-p', '/w/a.png'])
    expect(await pane.find({ key: 'peek', text: /松开 o 回到列表/ })).toBeUndefined()
    await pane.unmount()
  })
})
