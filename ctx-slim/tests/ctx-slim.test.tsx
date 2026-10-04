import { describe, expect, mock, test } from 'claude-code/testing'

import { droppedServers, filterInstructions } from '../hooks/register'

const TEXT = [
  '# MCP Server Instructions',
  '',
  'The following MCP servers have provided instructions for how to use their tools and resources:',
  '',
  '## claude.ai Claude Docs',
  'docs body',
  '',
  '## kando',
  'kando body',
  '',
  '## shadcn-io',
  'shadcn body',
  '',
  '## synco',
  'synco body',
].join('\n')

describe('filterInstructions', () => {
  test('drops only the servers the rule rejects', () => {
    const keep = (s: string) => s !== 'kando' && s !== 'synco'
    const out = filterInstructions(TEXT, keep) ?? ''
    expect(out).toContain('## claude.ai Claude Docs\ndocs body')
    expect(out).toContain('## shadcn-io\nshadcn body')
    expect(out).not.toContain('kando')
    expect(out).not.toContain('synco')
    expect(droppedServers(TEXT, keep)).toEqual(['kando', 'synco'])
  })

  test('keeps the text untouched when nothing is dropped', () => {
    expect(filterInstructions(TEXT, () => true)).toBe(TEXT)
  })

  test('drops the whole attachment when every server is dropped', () => {
    expect(filterInstructions(TEXT, () => false)).toBeNull()
  })
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

test('trims every turn but shows the notice only once per session', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/x' })
  on('session.cwd', () => ({ value: '/Users/x/Documents/Projects/Temp' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.ancestors', () => ({ value: [] }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  // 引擎自己在条带里什么也不画
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const send = () => $.prompt.attachment({ type: 'mcp_instructions_delta', text: TEXT, origin: { kind: 'engine' } })

  const band = await $.ui.mount({ plugin: 'ctx-slim', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const first = await send()
  expect(first.text).not.toContain('kando')
  expect(await band.find({ text: /本目录省略了/ })).toBeDefined()

  await clock.advance(30_000)
  expect(await band.find({ text: /本目录省略了/ })).toBeUndefined()

  const second = await send()
  expect(second.text).not.toContain('kando')
  expect(second.text).toContain('Claude Docs')
  expect(await band.find({ text: /本目录省略了/ })).toBeUndefined()
  await band.unmount()
})
