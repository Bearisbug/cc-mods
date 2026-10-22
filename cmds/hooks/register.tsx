import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CmdsEntry } from '../types'

const OTHER = '其他'
const PANE = 'cmds'
const ROWS = 16

const tip = atom({ plugin: 'cmds', key: 'tip' } as const, 0)
const list = atom({ plugin: 'cmds', key: 'list' } as const, [] as CmdsEntry[])

type Group = { title: string; names: string[] }

// 「组名: 命令 命令; 组名: 命令」，组之间用分号或换行隔开，命令之间用空格、逗号或顿号
function parseGroups(text: string): Group[] {
  return text
    .split(/[;；\n]/)
    .map(part => part.match(/^\s*([^:：]+?)\s*[:：](.*)$/))
    .filter(m => m !== null)
    .map(m => ({
      title: m[1] ?? '',
      names: (m[2] ?? '').split(/[\s,，、]+/).map(n => n.replace(/^\//, '')).filter(Boolean),
    }))
    .filter(g => g.title && g.names.length > 0)
}

// description 在括号外的第一个冒号或分号之前那段
function firstClause(text: string): string {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? ''
    if ('（(【[「'.includes(ch)) depth++
    else if ('）)】]」'.includes(ch)) depth = Math.max(0, depth - 1)
    else if (depth === 0 && '：:；;'.includes(ch) && i > 0) return text.slice(0, i).trim()
  }
  return text.trim()
}

function field(front: string, key: string): string {
  const m = front.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  return (m?.[1] ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
}

async function readDir($: EngineInterface, dir: string): Promise<CmdsEntry[]> {
  const entries = await $.fs.list(dir).catch(() => [])
  const found: CmdsEntry[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith('.md') || (entry.kind !== 'file' && !entry.isLink)) continue
    const text = await $.fs.read(`${dir}/${entry.name}`).catch(() => '')
    const front = typeof text === 'string' ? (text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '') : ''
    found.push({
      name: entry.name.slice(0, -3),
      args: field(front, 'argument-hint'),
      purpose: firstClause(field(front, 'description')),
    })
  }
  return found
}

// 用户级 ~/.claude/commands（或 $CLAUDE_CONFIG_DIR/commands）和当前项目的 .claude/commands，同名以项目的为准
async function load($: EngineInterface): Promise<void> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const byName = new Map<string, CmdsEntry>()
  const project = `${await $.session.cwd()}/.claude/commands`
  for (const entry of [...(await readDir($, `${config}/commands`)), ...(await readDir($, project))]) {
    byName.set(entry.name, entry)
  }
  await update($, list, () => [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)))
}

function grouped(entries: CmdsEntry[], groups: Group[]): { title: string; items: CmdsEntry[] }[] {
  const byName = new Map(entries.map(e => [e.name, e]))
  const placed = new Set<string>()
  const result = groups.map(g => ({
    title: g.title,
    items: g.names.flatMap(n => {
      const entry = byName.get(n)
      if (!entry || placed.has(n)) return []
      placed.add(n)
      return [entry]
    }),
  }))
  const rest = entries.filter(e => !placed.has(e.name))
  result.push({ title: groups.length > 0 ? OTHER : '全部命令', items: rest })
  return result.filter(g => g.items.length > 0)
}

export const register: Register = (on, options) => {
  const groups = parseGroups(typeof options.groups === 'string' ? options.groups : '')

  on('session.start', async ($, e, next) => {
    // immediate：Claude 回答中途输入也立刻开关，不排到这一轮结束
    await $.command.register({ name: 'cmds', description: '打开 / 关闭自定义短命令速查面板', immediate: true })
    await load($)

    return next(e)
  })

  // 同一个命令再输一次就关面板；面板拿着键盘：打开就能 ↑↓ 滚动，Esc 只关面板，不会中断 Claude
  on('command.run', { command: 'cmds' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
    } else {
      await load($)
      await $.ui.open({ id: PANE, title: '短命令', focus: true, closeOnEscape: true, rows: ROWS })
    }

    return {}
  })

  on('turn.complete', async ($, e, next) => {
    await update($, tip, n => n + 1)

    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.props.isDraft || e.props.isWorking) {
      return next(e)
    }
    const items = grouped(await read($, list), groups).flatMap(g => g.items)
    const item = items[(await read($, tip)) % items.length]
    if (!item) {
      return next(e)
    }

    return next({ ...e, props: { ...e.props, tail: `/${item.name} ${item.purpose} · /cmds 看全部` } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const sections = grouped(await read($, list), groups)
    // 右上角留给 Claude Code 自己画的关闭标记 ✕
    const hint = (
      <Box marginRight={3}>
        <Text dimColor>↑↓ 滚动 · Esc 关闭</Text>
      </Box>
    )

    if (sections.length === 0) {
      return (
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>没找到自定义命令：~/.claude/commands/ 和项目的 .claude/commands/ 下都没有 .md 文件</Text>
          {hint}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {sections.map((g, n) => (
          <Box key={g.title} flexDirection="column" marginBottom={n === sections.length - 1 ? 0 : 1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{g.title}</Text>
              {n === 0 ? hint : null}
            </Box>
            {g.items.map(item => (
              <Box key={item.name} flexDirection="column">
                <Text>
                  <Text bold color="cyan">/{item.name}</Text>
                  {item.args ? <Text dimColor> {item.args}</Text> : null}
                </Text>
                {item.purpose ? <Text>  {item.purpose}</Text> : null}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
