import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

type Api = EngineInterface
type Keep = (server: string) => boolean

const SYNCO_BLOCK = '<!-- synco:project-context:start'
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

async function rules($: Api): Promise<Keep> {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const lower = cwd.toLowerCase()

  const dirs: string[] = []
  for (let d = cwd; d.length > home.length && d.startsWith(home); d = d.slice(0, d.lastIndexOf('/'))) dirs.push(d)
  const hasPackageJson = (await Promise.all(dirs.map(d => $.fs.exists(`${d}/package.json`)))).some(Boolean)
  const instructions = await $.fs.ancestors({ names: ['CLAUDE.md', 'AGENTS.md'] }).catch(() => [])
  const hasSyncoBlock = instructions.some(f => f.content.includes(SYNCO_BLOCK))

  return server => {
    const name = server.toLowerCase()
    if (name === 'kando') return lower.includes('kando')
    if (name === 'synco') return hasSyncoBlock || lower.includes('synco')
    if (name === 'shadcn-io') return hasPackageJson
    return true
  }
}

export const register: Register = on => {
  on('prompt.attachment', { type: 'mcp_instructions_delta' }, async ($, e, next) => {
    const result = await next(e)
    if (!result.text) return result
    const keep = await rules($)
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
