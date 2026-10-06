import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Shot } from '../types'

type Api = EngineInterface

const PANE = 'shots'
const RECENT_MS = 10 * 60_000
const KEEP = 60
const shots = atom({ plugin: 'shot-view', key: 'shots' } as const, [])
// 在「未读」列表里的位置，0 是最新一张
const index = atom({ plugin: 'shot-view', key: 'index' } as const, 0)

// 状态条带里的提示：最新一张未读截图的路径，打开面板后清掉
let hint: string | null = null

// 截图文件在会话外被删、被移走或被覆盖时，Claude Code 不会因此重画。
// 条带有提示或面板开着时每 WATCH_MS 查一次文件，和上次画出来的不一样就重画
const WATCH_MS = 2000
let watching: Timer | null = null
let drawn = ''

// 按住 o：在终端里放大看，松开就收起；轻按 o：打开 macOS 快速查看。
// 插件收不到「松开」事件，只能靠按住时终端不断补发的重复按键来判断：
// HOLD_MS 内来了第二下就算按住，之后 RELEASE_MS 没再来就算松开；HOLD_MS 内没有第二下就算轻按
const HOLD_MS = 500
const RELEASE_MS = 220
type Press = { path: string; lastAt: number; isHeld: boolean; timer: Timer | null }
let press: Press | null = null
let isPeeking = false

// 只有按 r 才算已读：翻过、看过都不算
function unreadOf(list: Shot[]): Shot[] {
  return list.filter(s => !s.readAt)
}

// 文件现在还在不在、修改时间是多少：被删掉、移走或还是空文件的不显示（不然终端只能画一块黑），
// 被原地覆盖的把修改时间交给终端，让它重新读，不用缓存里的旧图
async function present($: Api, list: Shot[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  await Promise.all(
    list.map(async s => {
      const stat = await $.fs.stat(s.path).catch(() => undefined)
      if (stat?.kind === 'file' && stat.size > 0) out.set(s.path, Math.floor(stat.mtimeMs))
    }),
  )
  return out
}

function keyOf(live: Map<string, number>): string {
  return [...live]
    .map(([path, mtime]) => `${path}@${mtime}`)
    .sort()
    .join('\n')
}

function watchFiles($: Api) {
  if (watching) return
  watching = $.clock.every(WATCH_MS, () => void recheck($))
}

async function recheck($: Api) {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (!hint && !isOpen) {
    watching?.cancel()
    watching = null
    return
  }
  if (keyOf(await present($, unreadOf(await read($, shots)))) !== drawn) $.ui.invalidate('ui.render')
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

// 终端里汉字、全角标点和 emoji 占两格
export function cells(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    const isWide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      c >= 0x1f300
    n += isWide ? 2 : 1
  }
  return n
}

// 从中间截短：截图文件名的开头和结尾（时间戳、.png）都留着
function clipMiddle(s: string, width: number): string {
  if (cells(s) <= width) return s
  const chars = [...s]
  let head = ''
  let tail = ''
  let i = 0
  let j = chars.length - 1
  while (i < j && cells(head + chars[i]) <= Math.ceil((width - 1) / 2)) head += chars[i++]
  while (j >= i && cells(head) + 1 + cells(chars[j] + tail) <= width) tail = chars[j--] + tail
  return `${head}…${tail}`
}

const BAND_LABEL = '▍截图'
const MIN_HEAD = 20

// 条带固定一行。右端 4 格是 Claude Code 自己画的折叠按钮「 [-]」，bodyColumns 里含着它。
// 放不下时先去掉快捷键提示，再去掉张数，最后从中间截短文件名
export function bandLine(name: string, unread: number, bodyColumns: number): { head: string; tail: string } {
  const room = bodyColumns - 4 - cells(BAND_LABEL) - 1
  const head = `新增 ${name}`
  const headMin = Math.min(cells(head), MIN_HEAD)
  const tail = [`未读 ${unread} 张 · ctrl+x s 查看`, `未读 ${unread} 张`].find(t => headMin + 1 + cells(t) <= room) ?? ''
  return { head: clipMiddle(head, Math.max(2, room - (tail ? cells(tail) + 1 : 0))), tail }
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
    hint = newest.path
    $.ui.invalidate('ui.render')
    watchFiles($)
  }
}

// 放大只在当前面板里做（藏起标题、路径和按键，让图铺满）。不去改面板宽度：
// 停靠面板的宽度由 Claude Code 管，重新 open 带 columns 时宽度不升反降，还可能被记住
function setPeeking($: Api, on: boolean) {
  isPeeking = on
  $.ui.invalidate('ui.render')
}

async function watchRelease($: Api, p: Press) {
  if (press !== p) return
  if ((await $.clock.now()) - p.lastAt < RELEASE_MS) return
  p.timer?.cancel()
  press = null
  setPeeking($, false)
}

export async function pressPeek($: Api, path: string) {
  const now = await $.clock.now()
  const p = press
  if (!p || p.path !== path) {
    p?.timer?.cancel()
    const fresh: Press = { path, lastAt: now, isHeld: false, timer: null }
    press = fresh
    fresh.timer = $.clock.after(HOLD_MS, () => {
      if (press !== fresh || fresh.isHeld) return
      press = null
      void $.process.run(['qlmanage', '-p', path], { timeoutMs: 600_000 }).catch(() => undefined)
    })
    return
  }
  p.lastAt = now
  if (p.isHeld) return
  p.isHeld = true
  p.timer?.cancel()
  p.timer = $.clock.every(60, () => void watchRelease($, p))
  setPeeking($, true)
}

// 按面板能用的格子数缩图，保持宽高比（终端一格约是一宽两高）
function fit(shot: Shot, maxColumns: number, maxRows: number): { columns: number; rows: number } {
  let columns = maxColumns
  let rows = Math.round((columns * shot.height) / shot.width / 2)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(4, Math.round((rows * 2 * shot.width) / shot.height))
  }
  return { columns, rows: Math.min(255, rows) }
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
  const unread = unreadOf(await read($, shots))
  const live = await present($, unread)
  const at = unread.filter(s => live.has(s.path)).findIndex(s => s.path === restored)
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
    watchFiles($)
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
    if (!hint) return below
    const unread = unreadOf(await read($, shots))
    const live = await present($, unread)
    drawn = keyOf(live)
    // 提示的那张不在了就换成还在的最新一张；一张都不在了就不再提示
    if (!live.has(hint)) hint = unread.find(s => live.has(s.path))?.path ?? null
    if (!hint || e.props.hasSurvey) return below
    const { Box, Text } = $.ui.resolve(e)
    const line = bandLine(basename(hint), live.size, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0}>
            <Text color="ide" bold>
              {BAND_LABEL}
            </Text>
          </Box>
          <Text wrap="truncate-end">{line.head}</Text>
          {line.tail !== '' && (
            <Text dimColor wrap="truncate-end">
              {line.tail}
            </Text>
          )}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, shots)
    const unreadAll = unreadOf(list)
    const live = await present($, unreadAll)
    drawn = keyOf(live)
    const unread = unreadAll.filter(s => live.has(s.path))
    const gone = unreadAll.length - unread.length
    const readCount = list.length - unreadAll.length
    const at = Math.min(await read($, index), Math.max(0, unread.length - 1))
    const shot = unread[at]
    const undo = (
      <Button key="undo" plain hotkey="u" onPress={() => void undoRead($)}>
        撤销已读
      </Button>
    )
    const closeHint = <Text dimColor>Esc 或 ctrl+x s 关闭（面板开着时 Esc 只关面板，不会中断 Claude）</Text>
    const goneNote = gone > 0 && <Text dimColor>另有 {gone} 张截图的文件已不在（被删除或移走），不再显示</Text>
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
            <Text bold>{readCount === 0 ? '没有可看的截图' : '截图都看完了'}</Text>
            {readCount > 0 && <Text dimColor>已读 {readCount} 张</Text>}
          </Box>
          {goneNote}
          {readCount > 0 && undo}
          {closeHint}
        </Box>
      )
    }

    const visibleRows = Math.min(e.props.scroll.bodyRows, e.viewport?.rows ?? e.props.scroll.bodyRows)
    const alt = `${basename(shot.path)}（终端没有开启图片显示，轻按 o 用快速查看打开）`
    const pictureOf = (size: { columns: number; rows: number }) =>
      e.surface === 'terminal' ? (
        (() => {
          const { Image } = $.ui.resolve(e)
          return (
            <Image
              key="shot"
              source={{ file: shot.path, format: 'png', generation: live.get(shot.path) ?? 0 }}
              columns={size.columns}
              rows={size.rows}
              alt={alt}
            />
          )
        })()
      ) : (
        <Text dimColor>{alt}</Text>
      )

    // 按住 o 的放大视图：只留图和一行提示，图铺满面板。
    // 提示行本身就是绑着 o 的按键：按住时终端补发的重复按键要有地方接，否则会被当成已经松开
    if (isPeeking) {
      return (
        <Box flexDirection="column">
          {pictureOf(fit(shot, Math.max(10, e.props.bodyColumns), Math.max(4, visibleRows - 1)))}
          <Button key="peek" plain hotkey="o" dimColor onPress={() => void pressPeek($, shot.path)}>
            {`放大查看 ${basename(shot.path)} · 松开 o 回到列表`}
          </Button>
        </Box>
      )
    }

    // 普通视图按面板真正能显示的高度缩图：标题、路径、两排按键和两行说明约占 8 行，图片太高会把按键挤出去
    const picture = pictureOf(fit(shot, Math.max(10, e.props.bodyColumns - 2), Math.max(4, visibleRows - 8 - (gone > 0 ? 1 : 0))))

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
        {goneNote}
        {picture}
        <Box flexDirection="row" gap={2}>
          <Button key="next" plain hotkey="n" onPress={() => void update($, index, n => Math.min(n + 1, unread.length - 1))}>
            下一张
          </Button>
          <Button key="prev" plain hotkey="p" onPress={() => void update($, index, n => Math.max(n - 1, 0))}>
            上一张
          </Button>
          <Button key="read" plain hotkey="r" onPress={() => void markRead($, shot.path)}>
            标为已读
          </Button>
          {readCount > 0 && undo}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button key="peek" plain hotkey="o" onPress={() => void pressPeek($, shot.path)}>
            按住放大 · 轻按快速查看
          </Button>
          <Button key="reveal" plain hotkey="f" onPress={() => void $.process.run(['open', '-R', shot.path])}>
            Finder
          </Button>
          <Button key="copy" plain hotkey="y" onPress={press => void $.ui.copy({ text: shot.path, surface: press.surface })}>
            复制路径
          </Button>
        </Box>
        <Text dimColor>从最新一张开始，n 往后看更早的；看过、不需要再看了就按 r，它不会再出现，只是翻过不算已读</Text>
        {closeHint}
      </Box>
    )
  })
}
