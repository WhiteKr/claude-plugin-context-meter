import type { RateLimit } from '../types'

// Zone bounds in absolute tokens. Degradation follows the token count, not
// the share of the window, so a 1M window keeps the same bounds as a smaller
// one until they no longer fit, then falls back to shares of the window.
// Bounds for Opus 5.5 are estimates: Anthropic publishes no per-length scores
// for it, so they come from Opus 4.6/4.7 MRCR v2 and context-rot studies.
const ZONE_TOKENS = [100_000, 256_000, 512_000]
const ZONE_SHARES = [0.5, 0.75, 0.9]

export const ZONE_NAMES = ['최적', '양호', '저하 시작', '뚜렷한 저하']
export const ZONE_HEX = ['#639922', '#378ADD', '#EF9F27', '#E24B4A']

export type Level = 'ok' | 'warning' | 'danger'
export const LEVEL_HEX: Record<Level, string> = {
  ok: '#639922',
  warning: '#EF9F27',
  danger: '#E24B4A',
}

export const zoneBounds = (window: number): number[] =>
  ZONE_TOKENS.map((t, i) => Math.min(t, Math.round(window * (ZONE_SHARES[i] ?? 1))))

export const zoneOf = (tokens: number, bounds: number[]): number =>
  bounds.filter(b => tokens >= b).length

const ZONE_LEVEL: Level[] = ['ok', 'ok', 'warning', 'danger']
export const zoneLevel = (zone: number): Level => ZONE_LEVEL[zone] ?? 'danger'

// Average growth per turn over the last five turns; null until three turns
// give a usable trend.
export const growthPerTurn = (samples: number[]): number | null => {
  const recent = samples.slice(-6)
  if (recent.length < 4) return null
  const deltas = recent.slice(1).map((v, i) => v - (recent[i] ?? v))
  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length

  return avg > 0 ? avg : null
}

export const turnsUntil = (
  target: number,
  tokens: number,
  growth: number | null,
): number | null =>
  growth === null || target <= tokens ? null : Math.ceil((target - tokens) / growth)

// After a compaction the context shrinks: the old trend no longer applies.
export const addSample = (samples: number[], tokens: number): number[] =>
  samples.length > 0 && tokens < (samples[samples.length - 1] ?? 0)
    ? [tokens]
    : [...samples, tokens].slice(-12)

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3600_000,
  seven_day: 7 * 24 * 3600_000,
}
export const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: '지출' }

export type LimitView = {
  kind: string
  label: string
  used: number
  remaining: number
  level: Level
  resetInMs?: number
  // Usage expected at reset if the pace so far holds; absent while the
  // window is too young to judge.
  projectedUsed?: number
  exhaustInMs?: number
}

export const limitView = (rl: RateLimit, now: number): LimitView => {
  const used = Math.min(100, Math.max(0, rl.percentUsed))
  const remaining = Math.round((100 - used) * 10) / 10
  const span = WINDOW_MS[rl.kind]
  const resetAt = rl.resetsAt ? Date.parse(rl.resetsAt) : NaN
  const view: LimitView = {
    kind: rl.kind,
    label: LIMIT_LABEL[rl.kind] ?? rl.kind,
    used: Math.round(used * 10) / 10,
    remaining,
    level: 'ok',
  }
  if (!Number.isNaN(resetAt)) view.resetInMs = Math.max(0, resetAt - now)

  if (span && view.resetInMs !== undefined) {
    const elapsed = span - view.resetInMs
    if (elapsed > span * 0.1 && used >= 5) {
      const rate = used / elapsed
      view.projectedUsed = Math.round(rate * span)
      const exhaustIn = (100 - used) / rate
      if (exhaustIn < view.resetInMs) view.exhaustInMs = exhaustIn
    }
  }

  const soon = view.exhaustInMs !== undefined && view.exhaustInMs < 30 * 60_000
  if (remaining < 10 || soon) view.level = 'danger'
  else if (remaining < 25 || view.exhaustInMs !== undefined) view.level = 'warning'

  return view
}

// Rounded to whole thousands first, so 999.6k reads 1M and not 1000k.
export const fmtTokens = (n: number): string => {
  const k = Math.round(n / 1000)

  return k >= 1000 ? `${(n / 1_000_000).toFixed(k % 1000 === 0 ? 0 : 1)}M` : `${k}k`
}

// The two largest units, the smaller one left out when it is zero.
const durationIn =
  ([m, h, d]: string[], sep: string) =>
  (ms: number): string => {
    const min = Math.max(1, Math.round(ms / 60_000))
    if (min < 60) return `${min}${m}`
    const hours = Math.floor(min / 60)
    if (hours < 24) return min % 60 ? `${hours}${h}${sep}${min % 60}${m}` : `${hours}${h}`
    const days = Math.floor(hours / 24)

    return hours % 24 ? `${days}${d}${sep}${hours % 24}${h}` : `${days}${d}`
  }

export const fmtDuration = durationIn(['분', '시간', '일'], ' ')

// The compact form for the collapsed row: 40m, 3h53m, 5d15h.
export const fmtShortDuration = durationIn(['m', 'h', 'd'], '')

export const fmtPercent = (n: number): string =>
  `${Number.isInteger(n) ? n : n.toFixed(1)}%`

export type Hint = { text: string; tone: 'dim' | Level }

// One slot of text beside the context ring: the most urgent fact wins.
export const pickHint = (args: {
  tokens?: number
  bounds: number[]
  growth: number | null
  autoCompactAt?: number
  limits: LimitView[]
}): Hint | null => {
  const { tokens, bounds, growth, autoCompactAt, limits } = args
  const running = limits
    .filter(l => l.exhaustInMs !== undefined)
    .sort((a, b) => (a.exhaustInMs ?? 0) - (b.exhaustInMs ?? 0))[0]
  if (running?.exhaustInMs !== undefined) {
    return {
      text: `${running.label} 이 속도면 ${fmtDuration(running.exhaustInMs)} 후 소진`,
      tone: running.level,
    }
  }
  if (tokens === undefined) return null

  const toCompact =
    autoCompactAt === undefined ? null : turnsUntil(autoCompactAt, tokens, growth)
  if (toCompact !== null && toCompact <= 3) {
    return { text: `약 ${toCompact}턴 후 자동 압축`, tone: 'danger' }
  }

  const zone = zoneOf(tokens, bounds)
  const level = zoneLevel(zone)
  if (level !== 'ok') return { text: `${ZONE_NAMES[zone]} · 압축 권장`, tone: level }
  const bound = bounds[zone]
  const toNext = bound === undefined ? null : turnsUntil(bound, tokens, growth)
  if (toNext !== null && toNext <= 5) {
    return { text: `약 ${toNext}턴 후 ${ZONE_NAMES[zone + 1]}`, tone: 'dim' }
  }

  return { text: ZONE_NAMES[zone] ?? '', tone: 'dim' }
}

// A ring that starts at twelve o'clock. Ticks cut the track at the given
// fractions, so the next zone boundary shows on the ring itself.
export const ringSvg = (
  fraction: number,
  hex: string,
  ticks: number[] = [],
  size = 14,
): string => {
  const w = Math.round(size * 0.17 * 100) / 100
  const r = (size - w) / 2
  const c = size / 2
  const len = 2 * Math.PI * r
  const f = Math.min(1, Math.max(0, fraction))
  const cuts = ticks
    .map(t => {
      const a = t * 2 * Math.PI - Math.PI / 2
      const x = (d: number) => (c + d * Math.cos(a)).toFixed(2)
      const y = (d: number) => (c + d * Math.sin(a)).toFixed(2)
      const [inner, outer] = [r - w / 2, r + w / 2]

      return `<line x1="${x(inner)}" y1="${y(inner)}" x2="${x(outer)}" y2="${y(outer)}" stroke="rgba(128,128,128,0.9)" stroke-width="0.8"/>`
    })
    .join('')
  const arc =
    f > 0
      ? `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${hex}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="${(len * f).toFixed(2)} ${len.toFixed(2)}" transform="rotate(-90 ${c} ${c})"/>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(128,128,128,0.3)" stroke-width="${w}"/>${arc}${cuts}</svg>`
}

// The four zones as equal segments, so the place inside the current zone
// reads at a glance however wide the zone is in tokens. Each segment fills in
// its own color up to the current count; the bounds are labelled below.
export const zoneTrackSvg = (tokens: number, bounds: number[], window: number, width = 360): string => {
  const edges = [0, ...bounds, window]
  const gap = 3
  const seg = (width - gap * (edges.length - 2)) / (edges.length - 1)
  let body = ''
  for (let i = 0; i < edges.length - 1; i++) {
    const from = edges[i] ?? 0
    const to = edges[i + 1] ?? window
    const x = i * (seg + gap)
    const hex = ZONE_HEX[i] ?? '#888780'
    const fill = Math.min(1, Math.max(0, (tokens - from) / Math.max(1, to - from)))
    body += `<rect x="${x.toFixed(1)}" y="2" width="${seg.toFixed(1)}" height="6" rx="3" fill="${hex}" fill-opacity="0.22"/>`
    if (fill > 0) {
      body += `<rect x="${x.toFixed(1)}" y="2" width="${Math.max(6, seg * fill).toFixed(1)}" height="6" rx="3" fill="${hex}"/>`
    }
    const isLast = i === edges.length - 2
    const lx = x + seg + (isLast ? 0 : gap / 2)
    body += `<text x="${lx.toFixed(1)}" y="20" font-size="9" font-family="sans-serif" text-anchor="${isLast ? 'end' : 'middle'}" fill="#888780">${fmtTokens(to)}</text>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="22" viewBox="0 0 ${width} 22">${body}</svg>`
}

// The terminal has no Svg: a braille level stands in for the ring. Circle
// glyphs are East Asian Ambiguous width, which CJK terminals draw two cells
// wide over the next character; braille is narrow everywhere.
export const ringGlyph = (fraction: number): string =>
  ['⣀', '⣤', '⣶', '⣿'][Math.round(Math.min(1, Math.max(0, fraction)) * 3)] ?? '⣀'
