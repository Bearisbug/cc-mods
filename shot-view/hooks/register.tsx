import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shot } from '../types'

type Api = EngineInterface

const PANE = 'shots'
const RECENT_MS = 10 * 60_000
const KEEP = 60
const shots = atom({ plugin: 'shot-view', key: 'shots' } as const, [])
// 在「未读」列表里的位置，0 是最新一张
const index = atom({ plugin: 'shot-view', key: 'index' } as const, 0)

// 状态条带里的提示：最新一张未读截图的文件名，打开面板后清掉
let hint: string | null = null

// 只有按 r 才算已读：翻过、看过都不算
function unreadOf(list: Shot[]): Shot[] {
  return list.filter(s => !s.readAt)
}

export function findPngPaths(text: string): string[] {
  return [...new Set(text.match(/[\w@%+=:,.\/~-]+\.png\b/gi) ?? [])]
}

export function resolvePath(cwd: string, p: string, home: string): string {
  const abs = p.startsWith('/') ? p : p.startsWith('~/') ? home + p.slice(1) : `${cwd}/${p}`
  const out: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function ago(at: number): string {
  const min = Math.floor((Date.now() - at) / 60_000)
  return min < 1 ? '刚刚' : `${min} 分钟前`
}

async function pixelSize($: Api, path: string): Promise<{ width: number; height: number } | undefined> {
  const r = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path]).catch(() => undefined)
  const width = Number(/pixelWidth: (\d+)/.exec(r?.stdout ?? '')?.[1])
  const height = Number(/pixelHeight: (\d+)/.exec(r?.stdout ?? '')?.[1])
  return width > 0 && height > 0 ? { width, height } : undefined
}

async function record($: Api, candidates: string[], via: string, isRecentOnly: boolean) {
  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const now = Date.now()
  const found: Shot[] = []
  for (const raw of candidates.slice(0, 20)) {
    const path = resolvePath(cwd, raw, home)
    const stat = await $.fs.stat(path).catch(() => undefined)
    if (stat?.kind !== 'file' || (isRecentOnly && now - stat.mtimeMs > RECENT_MS)) continue
    const size = await pixelSize($, path)
    if (size) found.push({ path, at: now, via, mtimeMs: stat.mtimeMs, readAt: 0, ...size })
  }
  if (found.length === 0) return

  // 同一个文件、内容没变（修改时间相同）：保留原来的已读；文件被重新写过就是新截图，算未读
  const before = await read($, shots)
  const merged = found.map(f => {
    const old = before.find(s => s.path === f.path)
    return old && old.mtimeMs === f.mtimeMs ? { ...f, readAt: old.readAt } : f
  })
  const newest = unreadOf(merged).at(-1)
  await update($, shots, cur => [...[...merged].reverse(), ...cur.filter(s => !merged.some(f => f.path === s.path))].slice(0, KEEP))
  if (!newest) return
  await update($, index, () => 0)
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (!isOpen) {
    hint = basename(newest.path)
    $.ui.invalidate('ui.render')
  }
}

async function markRead($: Api, path: string) {
  const now = Date.now()
  await update($, shots, cur => cur.map(s => (s.path === path ? { ...s, readAt: now } : s)))
  const left = unreadOf(await read($, shots)).length
  await update($, index, n => Math.max(0, Math.min(n, left - 1)))
}

// 撤销最近一次「已读」，并跳到那一张
async function undoRead($: Api) {
  let restored = ''
  await update($, shots, cur => {
    const last = cur.filter(s => s.readAt).sort((a, b) => b.readAt - a.readAt)[0]
    restored = last?.path ?? ''
    return cur.map(s => (s.path === restored ? { ...s, readAt: 0 } : s))
  })
  if (restored === '') return
  const at = unreadOf(await read($, shots)).findIndex(s => s.path === restored)
  await update($, index, () => Math.max(0, at))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'shots', description: '在侧边面板查看本会话的截图', immediate: true })
    return next(e)
  })

  // 同一个快捷键再按一次就关面板；面板拿着键盘焦点，Esc 只关面板，不会中断 Claude
  on('command.run', { command: 'shots' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return {}
    }
    hint = null
    $.ui.invalidate('ui.render')
    await $.ui.open({ id: PANE, title: '截图', focus: true, closeOnEscape: true, rows: 30 })
    return {}
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    if (e.tool === 'Read') {
      const path = String(e.file_path ?? '')
      if (/\.png$/i.test(path)) await record($, [path], 'Read', false)
    } else {
      const candidates = findPngPaths(`${JSON.stringify(e)}\n${ran.text ?? ''}`)
      if (candidates.length > 0) await record($, candidates, e.tool, true)
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!hint || e.props.hasSurvey) return below
    const unread = unreadOf(await read($, shots)).length
    if (unread === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="ide" bold>
            ▍截图
          </Text>
          <Text>新增 {hint}</Text>
          <Text dimColor>未读 {unread} 张 · ctrl+x s 查看</Text>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, shots)
    const unread = unreadOf(list)
    const readCount = list.length - unread.length
    const at = Math.min(await read($, index), Math.max(0, unread.length - 1))
    const shot = unread[at]
    const undo = (
      <Button key="undo" plain hotkey="u" onPress={() => void undoRead($)}>
        撤销已读
      </Button>
    )
    const closeHint = <Text dimColor>Esc 或 ctrl+x s 关闭（面板开着时 Esc 只关面板，不会中断 Claude）</Text>
    if (list.length === 0) {
      return (
        <Box paddingX={1}>
          <Text dimColor>还没有截图。Claude 截图或查看 PNG 后会出现在这里。</Text>
        </Box>
      )
    }
    if (!shot) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Text color="success">✓</Text>
            <Text bold>截图都看完了</Text>
            <Text dimColor>已读 {readCount} 张</Text>
          </Box>
          {undo}
          {closeHint}
        </Box>
      )
    }

    const maxColumns = Math.max(10, e.props.bodyColumns - 2)
    const maxRows = Math.max(6, (e.viewport?.rows ?? 30) - 9)
    let columns = maxColumns
    let rows = Math.round((columns * shot.height) / shot.width / 2)
    if (rows > maxRows) {
      rows = maxRows
      columns = Math.max(4, Math.round((rows * 2 * shot.width) / shot.height))
    }
    const alt = `${basename(shot.path)}（终端没有开启图片显示，按 o 用预览打开）`
    const picture =
      e.surface === 'terminal' ? (
        (() => {
          const { Image } = $.ui.resolve(e)
          return <Image key="shot" source={{ file: shot.path, format: 'png' }} columns={columns} rows={Math.min(255, rows)} alt={alt} />
        })()
      ) : (
        <Text dimColor>{alt}</Text>
      )

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{basename(shot.path)}</Text>
          <Text color="suggestion">
            未读 {at + 1}/{unread.length}
          </Text>
          {readCount > 0 && <Text dimColor>已读 {readCount}</Text>}
          <Text dimColor>
            {ago(shot.at)} · {shot.via} · {shot.width}×{shot.height}
          </Text>
        </Box>
        <Text dimColor wrap="wrap">
          {shot.path}
        </Text>
        {picture}
        <Box flexDirection="row" gap={2}>
          <Button key="prev" plain hotkey="p" onPress={() => void update($, index, n => Math.min(n + 1, unread.length - 1))}>
            上一张
          </Button>
          <Button key="next" plain hotkey="n" onPress={() => void update($, index, n => Math.max(n - 1, 0))}>
            下一张
          </Button>
          <Button key="read" plain hotkey="r" onPress={() => void markRead($, shot.path)}>
            标为已读
          </Button>
          {readCount > 0 && undo}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button key="open" plain hotkey="o" onPress={() => void $.process.run(['open', shot.path])}>
            预览打开
          </Button>
          <Button key="reveal" plain hotkey="f" onPress={() => void $.process.run(['open', '-R', shot.path])}>
            Finder
          </Button>
          <Button key="copy" plain hotkey="y" onPress={press => void $.ui.copy({ text: shot.path, surface: press.surface })}>
            复制路径
          </Button>
        </Box>
        <Text dimColor>看过、不需要再看了就按 r，它不会再出现；只是翻过不算已读</Text>
        {closeHint}
      </Box>
    )
  })
}
