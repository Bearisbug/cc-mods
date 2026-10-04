import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

type Api = EngineInterface
type Keep = (server: string) => boolean

const NOTICE_MS = 30_000

// 每个会话只提示一次：记在会话级 state 里，/reload-plugins 后也不会再提示
const notified = atom({ plugin: 'ctx-slim', key: 'notified' } as const, false)

// 状态条带里的提示，显示 NOTICE_MS 后清掉
let notice: { servers: string[]; saved: number } | null = null

// 说明文本是一段总述，后面每个服务器一节 `## <名字>`
export function filterInstructions(text: string, keep: Keep): string | null {
  const [head = '', ...blocks] = text.split(/\n(?=## )/)
  if (blocks.length === 0) return text
  const kept = blocks.filter(b => keep((b.split('\n')[0] ?? '').slice(3).trim()))
  if (kept.length === blocks.length) return text
  return kept.length === 0 ? null : [head, ...kept].join('\n')
}

export function droppedServers(text: string, keep: Keep): string[] {
  return text
    .split(/\n(?=## )/)
    .slice(1)
    .map(b => (b.split('\n')[0] ?? '').slice(3).trim())
    .filter(name => !keep(name))
}

export type Condition = { kind: 'path' | 'file' | 'text'; value: string }
export type Rule = { server: string; conditions: Condition[] }

// 规则串：「服务器: 条件 | 条件; 服务器: 条件」。条件：path~子串、file=文件名、text=文字。
// 写错的段直接跳过；一条有效条件都没有的规则也跳过（不会因此把说明删掉）。
export function parseRules(spec: string): Rule[] {
  return spec
    .split(/[;\n]/)
    .map(segment => segment.trim())
    .flatMap(segment => {
      const colon = segment.indexOf(':')
      if (colon <= 0) return []
      const server = segment.slice(0, colon).trim().toLowerCase()
      const conditions = segment
        .slice(colon + 1)
        .split('|')
        .flatMap((raw): Condition[] => {
          const m = /^\s*(path)\s*~\s*(.+?)\s*$|^\s*(file|text)\s*=\s*(.+?)\s*$/.exec(raw)
          if (!m) return []
          if (m[1] && m[2]) return [{ kind: 'path', value: m[2].toLowerCase() }]
          if (m[3] && m[4]) return [{ kind: m[3] as 'file' | 'text', value: m[4] }]
          return []
        })
      return server && conditions.length > 0 ? [{ server, conditions }] : []
    })
}

async function keeper($: Api, rules: Rule[]): Promise<Keep> {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const lower = cwd.toLowerCase()
  const conditions = rules.flatMap(r => r.conditions)

  // file=：从当前目录往上找，在 HOME 之下时找到 HOME 为止
  const files = new Map<string, boolean>()
  const names = [...new Set(conditions.filter(c => c.kind === 'file').map(c => c.value))]
  if (names.length > 0) {
    const stop = home !== '' && cwd.startsWith(home) ? home : ''
    const dirs: string[] = []
    for (let d = cwd; d.length > stop.length && d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') dirs.push(d)
    for (const name of names) {
      files.set(name, (await Promise.all(dirs.map(d => $.fs.exists(`${d}/${name}`)))).some(Boolean))
    }
  }
  // text=：CLAUDE.md / AGENTS.md（含上级目录与 @include）
  const needsText = conditions.some(c => c.kind === 'text')
  const instructions = needsText ? await $.fs.ancestors({ names: ['CLAUDE.md', 'AGENTS.md'] }).catch(() => []) : []

  const holds = (c: Condition) =>
    c.kind === 'path' ? lower.includes(c.value) : c.kind === 'file' ? files.get(c.value) === true : instructions.some(i => i.content.includes(c.value))

  return server => {
    const rule = rules.find(r => r.server === server.toLowerCase())
    return rule === undefined || rule.conditions.some(holds)
  }
}

export const register: Register = (on, options) => {
  // 没配规则就什么都不做：不改说明，也不显示提示
  const rules = parseRules(typeof options.rules === 'string' ? options.rules : '')
  if (rules.length === 0) return

  on('prompt.attachment', { type: 'mcp_instructions_delta' }, async ($, e, next) => {
    const result = await next(e)
    if (!result.text) return result
    const keep = await keeper($, rules)
    const dropped = droppedServers(result.text, keep)
    if (dropped.length === 0) return result
    const text = filterInstructions(result.text, keep)
    if (await read($, notified)) return { ...result, text }
    await update($, notified, () => true)
    notice = { servers: dropped, saved: result.text.length - (text?.length ?? 0) }
    $.ui.invalidate('ui.render')
    $.clock.after(NOTICE_MS, () => {
      notice = null
      $.ui.invalidate('ui.render')
    })
    return { ...result, text }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!notice || e.props.hasSurvey) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="success" bold>
            ▍精简
          </Text>
          <Text>本目录省略了 {notice.servers.join('、')} 的 MCP 说明</Text>
          <Text dimColor>−{notice.saved} 字符</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
