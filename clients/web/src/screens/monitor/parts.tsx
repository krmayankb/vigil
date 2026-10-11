import { InfoTip } from '../../shared/InfoTip'
import { LevelBadge } from '../../shared/LevelBadge'
import { NotMeasured } from '../../shared/NotMeasured'
import type { MonitorMetric, PulseDay, WallBand } from '../../services/api'
import { count, hhmm, money, pct } from './format'

/** The ⓘ for a server-read number: its info line, and its limit when it has one. */
export function MetricTip({ label, metric, limit }: { label: string; metric: Pick<MonitorMetric, 'info' | 'unmeasured_reason'>; limit?: string }) {
  return <InfoTip label={`How ${label.toLowerCase()} is calculated`} source={metric.unmeasured_reason ?? undefined} calculation={metric.info} limit={limit} />
}

/** A value, or "Not measured yet" with why, never a guessed zero. */
export function Measured({ metric, render }: { metric: MonitorMetric; render: (value: number) => string }) {
  if (metric.unmeasured_text || metric.value == null) {
    return metric.unmeasured_reason ? <NotMeasured tip={metric.unmeasured_reason} /> : <span className="mn-dash">—</span>
  }
  return <>{render(metric.value)}</>
}

const W = 1000
const H = 220
const PAD = { l: 34, r: 12, t: 18, b: 26 }

/** The day's spine: alerts in (grey) and cases closed (green) per hour, cases running as a line, the cap dashed. */
export function DayChart({ day, tall = false }: { day: PulseDay; tall?: boolean }) {
  const height = tall ? 260 : H
  const n = day.hours.length
  const closed = day.closed_by_agents.map((a, i) => a + (day.closed_by_person[i] ?? 0))
  const top = Math.max(1, day.cap ?? 0, ...day.alerts_in, ...closed, ...day.running)
  const plotW = W - PAD.l - PAD.r
  const plotH = height - PAD.t - PAD.b
  const slot = plotW / n
  const bar = Math.max(2, slot * 0.34)
  const y = (v: number) => PAD.t + plotH - (v / top) * plotH
  const x = (i: number) => PAD.l + slot * i + slot / 2
  const line = day.running.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const peakIndex = day.peak.at ? day.hours.indexOf(day.peak.at) : -1
  const ticks = [0, 6, 12, 18].map((h) => Math.round((h / 24) * n)).filter((i) => i < n)
  // One gridline at half height, left out where it would sit on the cap's label.
  const grid = [Math.round(top / 2)].filter((v) => day.cap == null || Math.abs(y(v) - y(day.cap)) > 14)
  return (
    <svg className="mn-chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Alerts in, cases closed and cases running each hour, the last 24 hours">
      {grid.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="mn-grid" />
          <text x={PAD.l - 6} y={y(v) + 3} className="mn-axis" textAnchor="end">{v}</text>
        </g>
      ))}
      {day.cap != null && (
        <g>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(day.cap)} y2={y(day.cap)} className="mn-cap" />
          <text x={PAD.l - 6} y={y(day.cap) + 3} className="mn-axis cap" textAnchor="end">cap</text>
        </g>
      )}
      {day.hours.map((hour, i) => (
        <g key={hour}>
          <title>{`${hhmm(hour)} · ${day.alerts_in[i]} alerts in · ${closed[i]} closed (${day.closed_by_person[i]} by a person) · ${day.running[i]} running`}</title>
          <rect x={x(i) - bar - 1} y={y(day.alerts_in[i] ?? 0)} width={bar} height={Math.max(0, PAD.t + plotH - y(day.alerts_in[i] ?? 0))} className="mn-bar-in" rx="2" />
          <rect x={x(i) + 1} y={y(closed[i] ?? 0)} width={bar} height={Math.max(0, PAD.t + plotH - y(closed[i] ?? 0))} className="mn-bar-closed" rx="2" />
        </g>
      ))}
      <path d={line} className="mn-line" />
      {peakIndex >= 0 && day.peak.running > 0 && (
        <g>
          <circle cx={x(peakIndex)} cy={y(day.peak.running)} r="4" className="mn-peak" />
          <text x={peakIndex > n * 0.6 ? x(peakIndex) - 8 : x(peakIndex) + 8} y={y(day.peak.running) - 8} className="mn-peak-label" textAnchor={peakIndex > n * 0.6 ? 'end' : 'start'}>{`Peak ${day.peak.running} running at ${hhmm(day.peak.at)}`}</text>
        </g>
      )}
      {ticks.map((i) => (
        <text key={i} x={x(i)} y={height - 6} className="mn-axis" textAnchor="middle">{hhmm(day.hours[i])}</text>
      ))}
      <text x={x(n - 1)} y={height - 6} className="mn-axis" textAnchor="middle">now</text>
    </svg>
  )
}

/** Alerts waiting at intake at the end of each hour, against the high-water mark. */
export function QueueChart({ hours, queued, highWater }: { hours: string[]; queued: number[]; highWater: number | null }) {
  const height = 150
  const top = Math.max(1, highWater ?? 0, ...queued) * 1.1
  const plotW = W - PAD.l - PAD.r
  const plotH = height - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (plotW / Math.max(1, hours.length - 1)) * i
  const y = (v: number) => PAD.t + plotH - (v / top) * plotH
  const line = queued.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  return (
    <svg className="mn-chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Alerts waiting to be picked up, each hour, the last 24 hours">
      {highWater != null && (
        <g>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(highWater)} y2={y(highWater)} className="mn-cap fair" />
          <text x={PAD.l - 6} y={y(highWater) + 3} className="mn-axis fair" textAnchor="end">stop</text>
        </g>
      )}
      <path d={line} className="mn-line fair" />
      {queued.length > 0 && <circle cx={x(queued.length - 1)} cy={y(queued[queued.length - 1] ?? 0)} r="4" className="mn-now" />}
      {[0, 6, 12, 18].map((h) => Math.round((h / 24) * hours.length)).filter((i) => i < hours.length).map((i) => (
        <text key={i} x={x(i)} y={height - 6} className="mn-axis" textAnchor="middle">{hhmm(hours[i])}</text>
      ))}
    </svg>
  )
}

/** One row per workflow: running, today, cost per case, steps, waiting, and the share closed without a person. */
export function KindsTable({ kinds, info }: { kinds: WallBand[]; info: string }) {
  return (
    <section className="mn-card">
      <header className="mn-card-head">
        <h2>By kind of work</h2>
        <InfoTip label="How by kind of work is calculated" calculation={info} limit="No per-workflow concurrency cap is recorded yet." />
      </header>
      {kinds.length === 0 ? (
        <p className="mn-empty">No open cases yet.</p>
      ) : (
        <table className="mn-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th className="num">Running</th>
              <th className="num">Open</th>
              <th className="num">Runs today</th>
              <th className="num">Cost per case</th>
              <th className="num">Avg steps</th>
              <th className="num">Waiting</th>
              <th>Handled without a person</th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind) => (
              <tr key={kind.workflow_id}>
                <td className="mn-kind">{kind.name}</td>
                <td className="num" title={String(kind.running.cap_text ?? '')}>{count(kind.running.value)}</td>
                <td className="num">{count(kind.open)}</td>
                <td className="num">{count(kind.today)}</td>
                <td className="num">{money(kind.cost_per_case)}</td>
                <td className="num">{kind.mean_steps ?? '—'}</td>
                <td className="num">{count(kind.waiting)}</td>
                <td>
                  <span className="mn-rate">
                    <span className="num">{pct(kind.without_person.value)}</span>
                    <LevelBadge level={kind.without_person.level} variant="pill" />
                    {kind.without_person.value == null && <span className="mn-muted">no closes today</span>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
