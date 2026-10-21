import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { addSample, fmtTokens, growthPerTurn, limitView, pickHint, zoneBounds, zoneOf } from '../hooks/logic'

const HOUR = 3600_000
const NOW = Date.parse('2026-10-21T12:00:00Z')

const BAND = {
  plugin: 'context-meter',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const HINT = {
  plugin: 'context-meter',
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: '? for shortcuts' },
} as const

// Stands in for the engine's drawing: its hint line under the prompt, and
// an empty band above it.
const engineHint = (on: On) => {
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

test('zones follow absolute tokens, and shrink to fit a small window', async () => {
  expect(zoneBounds(1_000_000)).toEqual([100_000, 256_000, 512_000])
  expect(zoneBounds(200_000)).toEqual([100_000, 150_000, 180_000])
  expect(zoneOf(310_000, zoneBounds(1_000_000))).toBe(2)
  expect(zoneOf(50_000, zoneBounds(1_000_000))).toBe(0)
})

test('growth needs three turns, and a drop in context starts the trend over', async () => {
  expect(growthPerTurn([10, 20])).toBe(null)
  expect(growthPerTurn([10_000, 15_000, 20_000, 25_000])).toBe(5000)
  expect(addSample([10_000, 20_000, 30_000], 5000)).toEqual([5000])
  expect(addSample([10_000, 20_000], 30_000)).toEqual([10_000, 20_000, 30_000])
})

test('token counts round to whole thousands before the unit is chosen', async () => {
  expect(fmtTokens(310_000)).toBe('310k')
  expect(fmtTokens(999_600)).toBe('1M')
  expect(fmtTokens(1_000_000)).toBe('1M')
  expect(fmtTokens(1_500_000)).toBe('1.5M')
})

test('a limit burning faster than its window warns before it runs low', async () => {
  // 5h window, 1h gone, 60% used: at this pace it runs out in 40 minutes.
  const fast = limitView(
    { kind: 'five_hour', percentUsed: 60, resetsAt: new Date(NOW + 4 * HOUR).toISOString() },
    NOW,
  )
  expect(fast.remaining).toBe(40)
  expect(Math.round((fast.exhaustInMs ?? 0) / 60_000)).toBe(40)
  expect(fast.level).toBe('warning')

  // 4h gone, 30% used: steady, no warning.
  const calm = limitView(
    { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(NOW + HOUR).toISOString() },
    NOW,
  )
  expect(calm.level).toBe('ok')
  expect(calm.exhaustInMs).toBe(undefined)
})

test('the hint slot shows the most urgent fact', async () => {
  const bounds = zoneBounds(1_000_000)
  const limits = [
    limitView({ kind: 'five_hour', percentUsed: 60, resetsAt: new Date(NOW + 4 * HOUR).toISOString() }, NOW),
  ]
  expect(pickHint({ tokens: 50_000, bounds, growth: null, limits })?.text).toBe('5h 이 속도면 40분 후 소진')
  expect(pickHint({ tokens: 310_000, bounds, growth: null, limits: [] })?.text).toBe('저하 시작 · 압축 권장')
  expect(pickHint({ tokens: 90_000, bounds, growth: 5000, limits: [] })?.text).toBe('약 2턴 후 양호')
  expect(
    pickHint({ tokens: 300_000, bounds, growth: 20_000, autoCompactAt: 340_000, limits: [] })?.text,
  ).toBe('약 2턴 후 자동 압축')
})

const measure310k = async ($: Engine) =>
  $.session.measure({
    context: { tokens: 310_000, window: 1_000_000, percent: 31 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 10, resetsAt: new Date(NOW + 5 * 24 * HOUR + 15 * HOUR).toISOString() },
    ],
    cost: { usd: 1.42 },
    changed: ['context', 'rateLimits', 'cost'],
  })

const expectRow = async (ui: { find: (q: object) => Promise<{ text?: string } | undefined> }) => {
  expect((await ui.find({ type: 'Text', text: /^310k$/ }))?.text).toBe('310k')
  expect(await ui.find({ type: 'Text', text: /저하 시작 · 압축 권장/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^10%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5d15h$/ })).toBeDefined()
}

test('on desktop the band shows the meter and opens its panel upward', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: NOW }))
  await measure310k($)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await expectRow(ui)
  expect(await ui.find({ key: 'compact' })).toBeUndefined()

  await ui.press({ key: 'toggle' })
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
})

test('on the terminal the whole meter stays under the prompt', async ($, on) => {
  engineHint(on)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: NOW }))
  await measure310k($)

  const hint = await $.ui.mount({ ...HINT, surface: 'terminal' })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await expectRow(hint)
  expect(await hint.find({ type: 'Text', text: /^\? for shortcuts$/ })).toBeDefined()
  expect(await hint.find({ key: 'compact' })).toBeUndefined()

  await hint.press({ key: 'toggle' })
  expect(await hint.find({ key: 'compact' })).toBeDefined()
  expect(await hint.find({ key: 'toggle' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^310k$/ })).toBeUndefined()
  expect(await band.find({ key: 'compact' })).toBeUndefined()

  await hint.press({ key: 'toggle' })
  expect(await hint.find({ key: 'compact' })).toBeUndefined()
  await hint.unmount()
  await band.unmount()
})

// Stands in for the engine: usage and measurements report `context.tokens`.
const engine = (on: On) => {
  const state = { tokens: 0, toasts: [] as string[] }
  on('clock.now', () => ({ value: NOW }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { tokens: state.tokens, window: 1_000_000 }, rateLimits: [] },
  }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.toast', (_, e) => {
    state.toasts.push(e.text)
    return { value: undefined }
  })

  return state
}

const turnAt = async ($: Engine, state: { tokens: number }, tokens: number) => {
  state.tokens = tokens
  await $.session.measure({ context: { tokens, window: 1_000_000 }, rateLimits: [], changed: ['context'] })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
}

test('a degraded zone warns once, and again after a compaction', async ($, on) => {
  const state = engine(on)

  await turnAt($, state, 310_000)
  await turnAt($, state, 330_000)
  expect(state.toasts.filter(t => t.includes('저하 시작'))).toHaveLength(1)

  await turnAt($, state, 40_000)
  await turnAt($, state, 300_000)
  expect(state.toasts.filter(t => t.includes('저하 시작'))).toHaveLength(2)
})

test('the terminal draws the context ring as a narrow glyph', async ($, on) => {
  engineHint(on)
  const state = engine(on)
  await turnAt($, state, 500_000)

  const ui = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^⣶$/ })).toBeDefined()
  await ui.unmount()
})

test('a gateway spend limit shows in the row and its toast under one label', async ($, on) => {
  const toasts: string[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('clock.now', () => ({ value: NOW }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.measure({
    context: { tokens: 50_000, window: 1_000_000 },
    rateLimits: [{ kind: 'spend_limit', percentUsed: 95 }],
    changed: ['rateLimits'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^지출$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^95%$/ })).toBeDefined()
  expect(toasts).toEqual(['지출 한도: 5% 남았습니다.'])
  await ui.unmount()
})
