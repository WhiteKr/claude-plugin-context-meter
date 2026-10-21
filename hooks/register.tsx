import { atom, read, update } from 'claude-code'
import type {
  ElementTable,
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionRateLimit,
  SessionCost,
} from 'claude-code'

import type { Detail, Snapshot } from '../types'
import {
  LEVEL_HEX,
  ZONE_HEX,
  ZONE_NAMES,
  addSample,
  fmtDuration,
  fmtPercent,
  fmtShortDuration,
  fmtTokens,
  growthPerTurn,
  limitView,
  pickHint,
  ringGlyph,
  ringSvg,
  turnsUntil,
  zoneBounds,
  zoneLevel,
  zoneOf,
  zoneTrackSvg,
} from './logic'
import type { Level, LimitView } from './logic'

const snapshot = atom({ plugin: 'context-meter', key: 'snapshot' } as const, null)
const detail = atom({ plugin: 'context-meter', key: 'detail' } as const, null)
const samples = atom({ plugin: 'context-meter', key: 'samples' } as const, [])
const isOpen = atom({ plugin: 'context-meter', key: 'isOpen' } as const, false)
const warned = atom({ plugin: 'context-meter', key: 'warned' } as const, [])

const CATEGORY_NAMES: Record<string, string> = {
  Messages: '메시지',
  'System prompt': '시스템',
  'System tools': '도구',
  'MCP tools': 'MCP',
  'Memory files': '메모리',
  Skills: '스킬',
  'Custom agents': '에이전트',
}
const TRACK_WIDTH = 360
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']

const LEVEL_THEME: Record<Level, 'warning' | 'error' | undefined> = {
  ok: undefined,
  warning: 'warning',
  danger: 'error',
}

const toSnapshot = (u: {
  context: SessionContextUsage
  rateLimits: SessionRateLimit[]
  cost?: SessionCost
}): Snapshot => ({
  tokens: u.context.tokens,
  window: u.context.window,
  rateLimits: u.rateLimits,
  costUsd: u.cost?.usd,
})

const refreshDetail = async ($: EngineInterface): Promise<Snapshot> => {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  const s = toSnapshot(u)
  await update($, snapshot, () => s)
  if (!b) return s
  const next: Detail = {
    categories: b.categories
      .filter(c => c.kind === 'used' && c.tokens >= 500)
      .sort((x, y) => y.tokens - x.tokens)
      .map(c => ({ name: CATEGORY_NAMES[c.name] ?? c.name, tokens: c.tokens })),
    autoCompactAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
  }
  await update($, detail, () => next)

  return s
}

// Each warning shows once: a key per zone or per limit window and level.
// The check runs inside the write, so overlapping measurements toast once.
const warnOnce = async ($: EngineInterface, key: string, text: string) => {
  let isNew = false
  await update($, warned, list => {
    isNew = !list.includes(key)
    return isNew ? [...list, key].slice(-50) : list
  })
  if (isNew) $.ui.toast(text)
}

// What both sites draw from, read once per draw.
const readMeter = async ($: EngineInterface) => {
  const s = await read($, snapshot)
  if (s === null) return null
  const d = await read($, detail)
  const growth = growthPerTurn(await read($, samples))
  const now = await $.clock.now()
  const bounds = zoneBounds(s.window)
  const limits: LimitView[] = s.rateLimits
    .filter(rl => LIMIT_ORDER.includes(rl.kind))
    .sort((a, b) => LIMIT_ORDER.indexOf(a.kind) - LIMIT_ORDER.indexOf(b.kind))
    .map(rl => limitView(rl, now))
  const tokens = s.tokens
  const zone = tokens === undefined ? 0 : zoneOf(tokens, bounds)
  const hint = pickHint({ tokens, bounds, growth, autoCompactAt: d?.autoCompactAt, limits })

  return { s, d, open: await read($, isOpen), growth, bounds, limits, tokens, zone, hint }
}
type Meter = NonNullable<Awaited<ReturnType<typeof readMeter>>>

// The one-line meter. Its toggle is the last cell of the row, so the row
// never moves when the panel opens: the panel grows above it.
const meterRow = (
  $: EngineInterface,
  ui: ElementTable,
  Svg: ElementTable<'desktop'>['Svg'] | null,
  m: Meter,
  isNarrow: boolean,
) => {
  const { Box, Text, Button } = ui
  const { s, tokens, zone, hint, limits, bounds, open } = m

  const ring = (key: string, fraction: number, hex: string, alt: string, ticks: number[] = []) =>
    Svg ? (
      <Svg key={key} source={ringSvg(fraction, hex, ticks)} alt={alt} width={14} height={14} />
    ) : (
      <Text color={hex}>{ringGlyph(fraction)}</Text>
    )

  const contextItem = (
    <Box flexDirection="row" alignItems="center" gap="xs">
      {ring(
        'ring-context',
        tokens === undefined ? 0 : tokens / s.window,
        ZONE_HEX[zone] ?? '#888780',
        `콘텍스트 ${tokens === undefined ? '측정 전' : fmtTokens(tokens)}, ${ZONE_NAMES[zone]}`,
        bounds.map(b => b / s.window),
      )}
      <Text color={LEVEL_THEME[zoneLevel(zone)]} tabular>
        {tokens === undefined ? '--' : fmtTokens(tokens)}
      </Text>
      {hint && !isNarrow && (
        <Text
          color={hint.tone === 'dim' ? undefined : LEVEL_THEME[hint.tone]}
          dimColor={hint.tone === 'dim'}
          wrap="truncate-end"
        >
          {hint.text}
        </Text>
      )}
    </Box>
  )

  const limitItem = (v: LimitView) => {
    const color = LEVEL_THEME[v.level]
    return (
      <Box flexDirection="row" alignItems="center" gap="xs">
        {ring(`ring-${v.kind}`, v.used / 100, LEVEL_HEX[v.level], `${v.label} 한도 ${fmtPercent(v.used)} 사용`)}
        <Text dimColor>{v.label}</Text>
        <Text color={color} tabular>
          {fmtPercent(v.used)}
        </Text>
        {v.resetInMs !== undefined && !isNarrow && (
          <Text dimColor tabular>{fmtShortDuration(v.resetInMs)}</Text>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" alignItems="center" gap="md">
      {contextItem}
      {limits.map(limitItem)}
      <Box flexGrow={1} />
      {s.costUsd !== undefined && !isNarrow && <Text dimColor tabular>${s.costUsd.toFixed(2)}</Text>}
      <Button
        key="toggle"
        plain
        dimColor
        label={open ? '▾' : '▴'}
        onPress={() => void update($, isOpen, v => !v)}
      />
    </Box>
  )
}

// The details the toggle opens, drawn above the row so the row stays put.
const meterPanel = (
  $: EngineInterface,
  ui: ElementTable,
  Svg: ElementTable<'desktop'>['Svg'] | null,
  m: Meter,
  isWorking: boolean,
) => {
  const { Box, Text, Button } = ui
  const { s, d, growth, bounds, limits, tokens, zone } = m
  const used = d?.categories ?? []
  const toNext =
    tokens !== undefined && zone < bounds.length
      ? { left: (bounds[zone] ?? 0) - tokens, turns: turnsUntil(bounds[zone] ?? 0, tokens, growth) }
      : null
  const toCompact =
    tokens !== undefined && d?.autoCompactAt !== undefined
      ? turnsUntil(d.autoCompactAt, tokens, growth)
      : null

  // What to watch next: auto-compaction when it is close, else the next zone.
  const watch =
    toCompact !== null && toCompact <= 5
      ? `자동 압축까지 약 ${toCompact}턴`
      : toNext
        ? `${ZONE_NAMES[zone + 1] ?? ''}까지 ${fmtTokens(toNext.left)}${toNext.turns !== null ? ` · 약 ${toNext.turns}턴` : ''}`
        : '압축하거나 새 세션을 시작하세요'

  return (
    <Box flexDirection="column" gap="sm">
      <Box flexDirection="row" alignItems="center" gap="sm">
        {tokens !== undefined && <Text wrap="truncate-end">{watch}</Text>}
        <Box flexGrow={1} />
        {!isWorking && tokens !== undefined && (
          <Button
            key="compact"
            label="지금 압축"
            variant={zoneLevel(zone) !== 'ok' ? 'primary' : undefined}
            onPress={() =>
              void $.session
                .compact()
                .catch(() => $.ui.toast('지금은 압축할 수 없습니다. 턴이 끝난 뒤 다시 시도하세요.'))
            }
          />
        )}
      </Box>
      {Svg && tokens !== undefined && (
        <Svg
          key="track"
          source={zoneTrackSvg(tokens, bounds, s.window)}
          alt={`콘텍스트 ${fmtTokens(tokens)}, ${ZONE_NAMES[zone]} 구간`}
          width={TRACK_WIDTH}
          height={22}
        />
      )}
      {used.length > 0 && (
        <Text dimColor wrap="truncate-end">
          {used.slice(0, 3).map(c => `${c.name} ${fmtTokens(c.tokens)}`).join(' · ')}
        </Text>
      )}
      {limits.length > 0 && (
        <Box flexDirection="row" gap="lg">
          {limits.map(v => (
            <Text wrap="truncate-end">
              <Text dimColor>{v.label} </Text>
              {v.exhaustInMs !== undefined ? (
                <Text color={LEVEL_THEME[v.level]}>{fmtDuration(v.exhaustInMs)} 후 소진</Text>
              ) : (
                <Text dimColor>{v.resetInMs !== undefined ? `${fmtDuration(v.resetInMs)} 후 리셋` : '리셋 시각 모름'}</Text>
              )}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await refreshDetail($)

    return result
  })

  on('session.measure', async ($, e, next) => {
    const s = toSnapshot(e)
    await update($, snapshot, () => s)
    const now = await $.clock.now()

    if (s.tokens !== undefined) {
      const zone = zoneOf(s.tokens, zoneBounds(s.window))
      if (zoneLevel(zone) !== 'ok') {
        await warnOnce(
          $,
          `zone:${zone}`,
          `콘텍스트 ${fmtTokens(s.tokens)}: ${ZONE_NAMES[zone]} 구간입니다. 작업을 마무리하고 압축하세요.`,
        )
      }
    }
    for (const rl of s.rateLimits) {
      const v = limitView(rl, now)
      if (v.level === 'ok') continue
      const what =
        v.exhaustInMs !== undefined
          ? `이 속도면 ${fmtDuration(v.exhaustInMs)} 후 소진됩니다`
          : `${fmtPercent(v.remaining)} 남았습니다`
      await warnOnce($, `limit:${rl.kind}:${rl.resetsAt ?? ''}:${v.level}`, `${v.label} 한도: ${what}.`)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result

    const s = await refreshDetail($)
    if (s.tokens !== undefined) {
      const tokens = s.tokens
      await update($, samples, list => addSample(list, tokens))
      // A drop out of the degraded zones means a compaction or /clear: warn afresh.
      if (zoneLevel(zoneOf(tokens, zoneBounds(s.window))) === 'ok') {
        await update($, warned, list => list.filter(k => !k.startsWith('zone:')))
      }
    }

    return result
  })

  // On the terminal the meter lives under the prompt, row and panel alike,
  // where nothing the engine shows above the prompt (update and effort
  // notices) can push it away. The row is the last line: the panel opens
  // above it, so the toggle never moves.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const m = await readMeter($)
    const line = await next(e)
    if (m === null) return line
    const ui = $.ui.resolve(e)

    return (
      <ui.Box flexDirection="column">
        {line}
        {m.open && meterPanel($, ui, null, m, e.props.isWorking)}
        {meterRow($, ui, null, m, e.viewport !== undefined && e.viewport.columns < 70)}
      </ui.Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const m = await readMeter($)
    if (m === null) return next(e)

    const ui = $.ui.resolve(e)
    const Svg = 'Svg' in ui ? ui.Svg : null
    const row = meterRow($, ui, Svg, m, e.props.bodyColumns < 70)
    if (!m.open) return <ui.Box flexDirection="column">{row}</ui.Box>

    // Spacing by step, not by cell: a desktop cell is a text line, often a
    // fractional pixel height, and the band then shifts the row by a pixel.
    return (
      <ui.Box flexDirection="column" gap="md">
        {meterPanel($, ui, Svg, m, e.props.isWorking)}
        {row}
      </ui.Box>
    )
  })
}
