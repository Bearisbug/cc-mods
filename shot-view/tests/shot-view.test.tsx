import { describe, expect, test } from 'claude-code/testing'

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
  expect(image?.props.source).toEqual({ file: '/w/shots/home.png', format: 'png' })
  expect(await ui.find({ text: '1/2' })).toBeDefined()

  await ui.press({ key: 'prev' })
  expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ file: '/w/shots/old.png', format: 'png' })
  await ui.unmount()

  const desktop = await $.ui.mount({ plugin: 'shot-view', surface: 'desktop', component: 'Pane', requestId: 'shots', props: PANE_PROPS })
  expect(await desktop.find({ text: /终端没有开启图片显示/ })).toBeDefined()
  await desktop.unmount()
})
