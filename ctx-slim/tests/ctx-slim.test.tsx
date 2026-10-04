import { describe, expect, mock, test } from 'claude-code/testing'

import { droppedServers, filterInstructions, parseRules } from '../hooks/register'

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

// 作者本机在用的规则，也是 README 里的示例
const RULES = 'kando: path~kando; synco: text=<!-- synco:project-context:start | path~synco; shadcn-io: file=package.json'

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

describe('parseRules', () => {
  test('reads servers and their path / file / text conditions', () => {
    expect(parseRules(RULES)).toEqual([
      { server: 'kando', conditions: [{ kind: 'path', value: 'kando' }] },
      {
        server: 'synco',
        conditions: [
          { kind: 'text', value: '<!-- synco:project-context:start' },
          { kind: 'path', value: 'synco' },
        ],
      },
      { server: 'shadcn-io', conditions: [{ kind: 'file', value: 'package.json' }] },
    ])
  })

  test('takes newlines as separators, lowercases server names and path conditions, skips broken parts', () => {
    expect(parseRules('Kando : path ~ /Kando/\nno colon here; empty:; bad: size>3 | file = go.mod')).toEqual([
      { server: 'kando', conditions: [{ kind: 'path', value: '/kando/' }] },
      { server: 'bad', conditions: [{ kind: 'file', value: 'go.mod' }] },
    ])
  })

  test('an empty spec has no rules', () => {
    expect(parseRules('')).toEqual([])
    expect(parseRules(' ; ')).toEqual([])
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

type On = Parameters<Parameters<typeof test>[1] extends infer B ? (B extends (...a: infer A) => unknown ? (...a: A) => unknown : never) : never>[1]

// 一台假机器：当前目录、存在的文件、CLAUDE.md 内容
function machine(on: On, world: { cwd: string; files?: string[]; claudeMd?: string }) {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/x' })
  on('session.cwd', () => ({ value: world.cwd }))
  on('fs.exists', ($, e) => ({ value: (world.files ?? []).includes(e.path) }))
  on('fs.ancestors', () => ({
    value: world.claudeMd === undefined ? [] : [{ dir: world.cwd, name: 'CLAUDE.md', content: world.claudeMd, parts: [] }],
  }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  // 引擎自己在条带里什么也不画
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return clock
}

const ATTACHMENT = { type: 'mcp_instructions_delta' as const, text: TEXT, origin: { kind: 'engine' as const } }

test('with no rules configured it changes nothing and shows nothing', async ($, on) => {
  machine(on, { cwd: '/Users/x/Documents/Projects/Temp' })
  const band = await $.ui.mount({ plugin: 'ctx-slim', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  const out = await $.prompt.attachment(ATTACHMENT)
  expect(out.text).toBe(TEXT)
  expect(await band.find({ text: /本目录省略了/ })).toBeUndefined()
  await band.unmount()
})

test('the author\'s rules reproduce the old behaviour in Temp, and the notice shows once', { options: { rules: RULES } }, async ($, on) => {
  const clock = machine(on, { cwd: '/Users/x/Documents/Projects/Temp' })
  const band = await $.ui.mount({ plugin: 'ctx-slim', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  const first = await $.prompt.attachment(ATTACHMENT)
  expect(first.text).toContain('Claude Docs')
  expect(first.text).not.toContain('kando')
  expect(first.text).not.toContain('shadcn')
  expect(first.text).not.toContain('synco')
  expect(await band.find({ text: '本目录省略了 kando、shadcn-io、synco 的 MCP 说明' })).toBeDefined()

  await clock.advance(30_000)
  const second = await $.prompt.attachment(ATTACHMENT)
  expect(second.text).not.toContain('kando')
  expect(await band.find({ text: /本目录省略了/ })).toBeUndefined()
  await band.unmount()
})

test('each condition kind keeps its server where it holds', { options: { rules: RULES } }, async ($, on) => {
  machine(on, {
    cwd: '/Users/x/Documents/Projects/Kando/web',
    files: ['/Users/x/Documents/Projects/Kando/package.json'],
    claudeMd: '# Kando\n<!-- synco:project-context:start -->\n...',
  })
  const out = await $.prompt.attachment(ATTACHMENT)
  expect(out.text).toBe(TEXT)
})

test('a file above HOME does not count, and an unlisted server is always kept', { options: { rules: 'shadcn-io: file=package.json' } }, async ($, on) => {
  machine(on, { cwd: '/Users/x/Documents/notes', files: ['/Users/package.json'] })
  const out = await $.prompt.attachment(ATTACHMENT)
  expect(out.text).not.toContain('shadcn')
  expect(out.text).toContain('## kando')
  expect(out.text).toContain('## synco')
})
