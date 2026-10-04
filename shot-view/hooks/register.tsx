import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Shot } from '../types'

type Api = EngineInterface

const PANE = 'shots'
const RECENT_MS = 10 * 60_000
const shots = atom({ plugin: 'shot-view', key: 'shots' } as const, [])
const index = atom({ plugin: 'shot-view', key: 'index' } as const, 0)

// 状态条带里的提示：最新一张截图的文件名与总张数，打开面板后清掉
let hint: { name: string; total: number } | null = null

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
    if (size) found.push({ path, at: now, via, ...size })
  }
  const newest = found.at(-1)
  if (!newest) return

  await update($, shots, cur => [...found.reverse(), ...cur.filter(s => !found.some(f => f.path === s.path))].slice(0, 30))
  await update($, index, () => 0)
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (!isOpen) {
    hint = { name: basename(newest.path), total: (await read($, shots)).length }
    $.ui.invalidate('ui.render')
  }
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
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color="ide" bold>
            ▍截图
          </Text>
          <Text>新增 {hint.name}</Text>
          <Text dimColor>共 {hint.total} 张 · ctrl+x s 查看</Text>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, shots)
    const at = Math.min(await read($, index), Math.max(0, list.length - 1))
    const shot = list[at]
    if (!shot) {
      return (
        <Box paddingX={1}>
          <Text dimColor>还没有截图。Claude 截图或查看 PNG 后会出现在这里。</Text>
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
            {at + 1}/{list.length}
          </Text>
          <Text dimColor>
            {ago(shot.at)} · {shot.via} · {shot.width}×{shot.height}
          </Text>
        </Box>
        <Text dimColor wrap="wrap">
          {shot.path}
        </Text>
        {picture}
        <Box flexDirection="row" gap={2}>
          <Button key="prev" plain hotkey="p" onPress={() => void update($, index, n => Math.min(n + 1, list.length - 1))}>
            上一张
          </Button>
          <Button key="next" plain hotkey="n" onPress={() => void update($, index, n => Math.max(n - 1, 0))}>
            下一张
          </Button>
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
        <Text dimColor>Esc 或 ctrl+x s 关闭（面板开着时 Esc 只关面板，不会中断 Claude）</Text>
      </Box>
    )
  })
}
