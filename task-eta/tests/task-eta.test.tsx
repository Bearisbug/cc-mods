import { describe, expect, mock, test } from 'claude-code/testing'

import {
  applyCheck,
  checkPrompt,
  planPrompt,
  describe as describeCall,
  duration,
  parseCheck,
  parsePlan,
  remainingMinutes,
  spent,
  stepAfter,
} from '../hooks/register'

const PLAN = [
  { title: '跑单元测试', signals: ['npm test', 'vitest'], minutes: 4 },
  { title: '构建 iOS', signals: ['xcodebuild'], minutes: 8 },
  { title: '截图验证', signals: ['simctl io', 'screenshot'], minutes: 3 },
]

describe('parsePlan', () => {
  test('reads the JSON even with prose around it', () => {
    const text = '好的：\n{"steps":[{"title":"构建 iOS","signals":["XcodeBuild"," "],"minutes":8},{"title":"缺分钟"}]}\n以上'
    expect(parsePlan(text)).toEqual([{ title: '构建 iOS', signals: ['xcodebuild'], minutes: 8 }])
  })

  test('returns nothing for a reply without JSON', () => {
    expect(parsePlan('我不确定')).toEqual([])
  })
})

describe('stepAfter only moves one step, and only on evidence', () => {
  test('a hit on the current step marks it as really being worked on', () => {
    expect(stepAfter(PLAN[0], PLAN[1], '{"command":"npm test"}', false)).toBe('hit')
  })

  test('the next step starting ticks the current one only after the current one was hit', () => {
    expect(stepAfter(PLAN[0], PLAN[1], '{"command":"xcodebuild"}', true)).toBe('advance')
    expect(stepAfter(PLAN[0], PLAN[1], '{"command":"xcodebuild"}', false)).toBe('stay')
  })

  test('a keyword from two steps ahead never skips anything', () => {
    expect(stepAfter(PLAN[0], PLAN[1], '{"command":"xcrun simctl io booted screenshot a.png"}', true)).toBe('stay')
  })

  test('steps sharing a keyword advance once the current one was hit', () => {
    const same = { title: '再跑一次', signals: ['sleep 20'], minutes: 0.5 }
    expect(stepAfter(same, same, '{"command":"sleep 20"}', false)).toBe('hit')
    expect(stepAfter(same, same, '{"command":"sleep 20"}', true)).toBe('advance')
  })
})

describe('Claude checking the existing list', () => {
  test('parseCheck reads done, current, additions and whether it is the same task', () => {
    const text = '{"same_task":false,"done":[1,2],"current":3,"add":[{"title":"上传产物","signals":["upload"],"minutes":1}]}'
    expect(parseCheck(text)).toEqual({
      isSameTask: false,
      done: [1, 2],
      current: 3,
      add: [{ title: '上传产物', signals: ['upload'], minutes: 1 }],
    })
  })

  test('applyCheck ticks what Claude confirms, unticks what it does not, keeps titles and appends additions', () => {
    const now = 1_000_000
    const items = PLAN.map((s, i) => ({
      ...s,
      status: (i === 0 ? 'done' : i === 1 ? 'active' : 'todo') as 'done' | 'active' | 'todo',
      startedAt: 0,
      endedAt: 0,
      tools: 0,
      isUntimed: false,
    }))
    const t = { items, isCurrentHit: true }
    applyCheck(t, { isSameTask: true, done: [2, 3], current: 4, add: [{ title: '上传产物', signals: ['upload'], minutes: 1 }] }, now)
    expect(t.items.map(i => `${i.title}:${i.status}`)).toEqual(['跑单元测试:todo', '构建 iOS:done', '截图验证:done', '上传产物:active'])
    expect(t.items[2]?.isUntimed).toBe(true)
    expect(t.isCurrentHit).toBe(false)
  })
})

test('remainingMinutes counts what is left of the current step plus the later ones', () => {
  expect(remainingMinutes(PLAN, 1, 2 * 60_000)).toBe(6 + 3)
  expect(remainingMinutes(PLAN, 2, 10 * 60_000)).toBe(0)
  expect(remainingMinutes(PLAN, 1, 0, 0.5)).toBe(4 + 1.5)
})

test('duration, spent and describe', () => {
  expect(duration(0.5)).toBe('30 秒')
  expect(duration(4.4)).toBe('4 分')
  expect(spent(45_000)).toBe('45 秒')
  expect(spent(72_000)).toBe('1 分 12 秒')
  expect(spent(15 * 60_000)).toBe('15 分')
  expect(describeCall({ tool: 'Bash', command: 'npm test -- --run\necho done' })).toBe('$ npm test -- --run')
  expect(describeCall({ tool: 'Edit', file_path: '/w/src/register.tsx' })).toBe('Edit register.tsx')
  expect(describeCall({ tool: 'mcp__kando__content_get' })).toBe('kando：content_get')
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 20,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}
const PANE_PROPS = {
  title: '任务步骤',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}
const RUN = { args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 140 } }
const PLAN_REPLY = JSON.stringify({
  steps: [
    { title: '跑单元测试', signals: ['npm test'], minutes: 2 },
    { title: '构建 iOS', signals: ['xcodebuild'], minutes: 5 },
    { title: '截图验证', signals: ['screenshot'], minutes: 1 },
  ],
})
const USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

// 让测试里的「Claude」按提问内容回答：估算给 PLAN_REPLY，核对给 replies.check
function engine(
  on: Parameters<Parameters<typeof test>[1] extends infer B ? (B extends (...a: infer A) => unknown ? (...a: A) => unknown : never) : never>[1],
  replies: { check: string; noReplyYet?: boolean; slowCheck?: () => Promise<void>; prompts?: string[] },
) {
  const open = new Set<string>()
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' }))
  on('model.fork', async ($, e) => {
    replies.prompts?.push(e.prompt)
    const isCheck = e.prompt.includes('核对')
    if (isCheck && replies.slowCheck) await replies.slowCheck()
    return {
      value: replies.noReplyYet
        ? { isAnswered: false as const, reason: 'nothing-to-fork' as const }
        : { isAnswered: true as const, text: isCheck ? replies.check : PLAN_REPLY, usage: USAGE },
    }
  })
  on('ui.panes', () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.open', ($, e) => {
    open.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return open
}

test('ctrl+x p estimates on demand, lists the steps in a focused pane, and closes it again', async ($, on) => {
  const clock = mock.clock(on)
  const open = engine(on, { check: '{"done":[],"current":1,"add":[]}' })

  const band = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: '跑测试再构建', turnId: 't1' })
  expect(await band.find({ text: /▍进度/ })).toBeUndefined()

  const run = await $.command.run({ command: 'steps', ...RUN })
  expect(run.text).toBeUndefined()
  await clock.settle()
  expect(open.has('steps')).toBe(true)
  expect(await band.find({ text: '1/3 跑单元测试' })).toBeDefined()
  expect(await band.find({ text: /下一步 构建 iOS/ })).toBeDefined()

  const pane = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'Pane', requestId: 'steps', props: PANE_PROPS })
  expect(await pane.find({ text: '跑测试再构建' })).toBeDefined()

  // 下一步的关键词先出现，但当前步骤还没被命中过：不打勾
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme App' })
  expect(await band.find({ text: '1/3 跑单元测试' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^✓$/ })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme App' })
  expect(await band.find({ text: '2/3 构建 iOS' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
  expect(await pane.find({ text: '└ $ xcodebuild -scheme App' })).toBeDefined()

  await $.command.run({ command: 'steps', ...RUN })
  expect(open.has('steps')).toBe(false)
  await pane.unmount()
  await band.unmount()
})

test('an interrupted task keeps its list; the next message continues it unless Claude says it is a new task', async ($, on) => {
  const clock = mock.clock(on)
  const replies = { check: '' }
  engine(on, replies)
  const band = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })

  await $.turn.start({ text: '跑测试再构建', turnId: 't1' })
  await $.command.run({ command: 'steps', ...RUN })
  await clock.settle()
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme App' })
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't1', reason: 'aborted' })
  expect(await band.find({ text: '已中断' })).toBeDefined()
  expect(await band.find({ text: /完成 1\/3 步/ })).toBeDefined()

  replies.check = '{"same_task":true,"done":[1],"current":2,"add":[{"title":"上传产物","signals":["upload"],"minutes":1}]}'
  await $.turn.start({ text: '构建换成 Release 配置', turnId: 't2' })
  await clock.settle()
  expect(await band.find({ text: '2/4 构建 iOS' })).toBeDefined()

  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 't2', reason: 'aborted' })
  replies.check = '{"same_task":false,"done":[],"current":1,"add":[]}'
  await $.turn.start({ text: '帮我写一份周报', turnId: 't3' })
  await clock.settle()
  expect(await band.find({ text: '1/3 跑单元测试' })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'Pane', requestId: 'steps', props: PANE_PROPS })
  expect(await pane.find({ text: '帮我写一份周报' })).toBeDefined()
  await pane.unmount()
})

test('with no task, ctrl+x p still toggles the pane silently', async ($, on) => {
  mock.clock(on)
  const open = engine(on, { check: '{"done":[],"current":1,"add":[]}' })
  const idle = await $.command.run({ command: 'steps', ...RUN })
  expect(idle.text).toBeUndefined()
  expect(open.has('steps')).toBe(true)
  const pane = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'Pane', requestId: 'steps', props: PANE_PROPS })
  expect(await pane.find({ text: /还没有任务记录/ })).toBeDefined()
  await pane.unmount()
  await $.command.run({ command: 'steps', ...RUN })
  expect(open.has('steps')).toBe(false)
})

test('A: pressing ctrl+x p before Claude has replied waits, then estimates as soon as a reply exists', async ($, on) => {
  const clock = mock.clock(on)
  const replies = { check: '{"done":[],"current":1,"add":[]}', noReplyYet: true }
  engine(on, replies)
  const band = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: '跑测试再构建', turnId: 't1' })
  await $.command.run({ command: 'steps', ...RUN })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: '等 Claude 第一次回复后估算' })).toBeDefined()

  replies.noReplyYet = false
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.settle()
  expect(await band.find({ text: '1/3 跑单元测试' })).toBeDefined()
  await band.unmount()
})

test('B: a list estimated while step 1 is already running still advances', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, { check: '{"done":[],"current":1,"add":[]}' })
  const band = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: '跑测试再构建', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'sleep 50 # 跑单元测试' })
  await $.command.run({ command: 'steps', ...RUN })
  await clock.settle()
  expect(await band.find({ text: '1/3 跑单元测试' })).toBeDefined()
  await $.tool.call({ tool: 'Bash', command: 'xcodebuild -scheme App' })
  expect(await band.find({ text: '2/3 构建 iOS' })).toBeDefined()
  await band.unmount()
})

describe('C: the check at a normal end ticks what finished', () => {
  test('parseCheck accepts numbers written as strings and step titles', () => {
    expect(parseCheck('{"done":["1","构建 iOS"],"current":"3"}', ['跑单元测试', '构建 iOS', '截图验证'])).toEqual({
      isSameTask: true,
      done: [1, 2],
      current: 3,
      add: [],
    })
  })

  test('the prompt carries the final answer and says output-less commands count once run', () => {
    const items = PLAN.map(st => ({ ...st, status: 'todo' as const, startedAt: 0, endedAt: 0, tools: 0, isUntimed: false }))
    const prompt = checkPrompt(items, { answer: '好了' })
    expect(prompt).toContain('你最后的回复是：「好了」')
    expect(prompt).toContain('没有输出的命令（如 sleep、等待）执行完也算完成')
  })

  test('after a normal end the band turns into 任务完成 once Claude confirms every step', async ($, on) => {
    const clock = mock.clock(on)
    engine(on, { check: '{"done":["1","2","3"],"current":3,"add":[]}' })
    const band = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await $.turn.start({ text: '跑测试再构建', turnId: 't1' })
    await $.command.run({ command: 'steps', ...RUN })
    await clock.settle()
    await $.turn.complete({ answer: '好了', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.settle()
    expect(await band.find({ type: 'Text', text: '任务完成' })).toBeDefined()
    await band.unmount()
  })
})

test('D: the progress line is one row of Texts, not a nested column', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, { check: '{"done":[],"current":1,"add":[]}' })
  const band = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: '跑测试再构建', turnId: 't1' })
  await $.command.run({ command: 'steps', ...RUN })
  await clock.settle()
  const tree = (await band.drawn()) as unknown as { children: { props: { flexDirection?: string }; children: { type: string }[] }[] }
  const row = tree.children[0]
  expect(row?.props.flexDirection).toBe('row')
  expect(row?.children.map(c => c.type)).toEqual(['Text', 'Text', 'Text', 'Text'])
  await band.unmount()
})

describe('E: estimates see what already ran, and generic commands are not keywords', () => {
  test('planPrompt lists the calls already made and forbids generic command names', () => {
    const prompt = planPrompt(['$ xcrun simctl io booted screenshot home.png', '$ sleep 70'])
    expect(prompt).toContain('1. $ xcrun simctl io booted screenshot home.png')
    expect(prompt).toContain('不要用 sleep、cd、ls')
  })

  test('parsePlan drops sleep / cd style signals but keeps specific ones', () => {
    const text = '{"steps":[{"title":"等编译","signals":["sleep","sleep 50 # 编译","CD"],"minutes":1}]}'
    expect(parsePlan(text)).toEqual([{ title: '等编译', signals: ['sleep 50 # 编译'], minutes: 1 }])
  })

  test('the estimate prompt carries this turn\'s calls', async ($, on) => {
    const clock = mock.clock(on)
    const prompts: string[] = []
    engine(on, { check: '{"done":[],"current":1,"add":[]}', prompts })
    await $.turn.start({ text: '截屏再编译', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'xcrun simctl io booted screenshot home.png' })
    await $.command.run({ command: 'steps', ...RUN })
    await clock.settle()
    expect(prompts[0]).toContain('$ xcrun simctl io booted screenshot home.png')
  })
})

test('F: between a normal end and the check finishing, the band says 正在核对 instead of 已暂停', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, { check: '{"done":["1","2","3"],"current":3,"add":[]}', slowCheck: () => clock.sleep(10_000) })
  const band = await $.ui.mount({ plugin: 'task-eta', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
  await $.turn.start({ text: '跑测试再构建', turnId: 't1' })
  await $.command.run({ command: 'steps', ...RUN })
  await clock.settle()
  await $.turn.complete({ answer: '好了', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: '正在核对…' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '已暂停' })).toBeUndefined()
  await clock.advance(10_000)
  expect(await band.find({ type: 'Text', text: '任务完成' })).toBeDefined()
  await band.unmount()
})
