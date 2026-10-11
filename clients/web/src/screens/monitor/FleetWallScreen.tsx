import { useEffect, useState } from 'react'
import { InfoTip } from '../../shared/InfoTip'
import { LevelBadge } from '../../shared/LevelBadge'
import { EmptyState } from '../../shared/ui'
import type { ConsoleScreenProps } from '../../shared/types'
import { monitorApi, type FleetWallPayload, type WallCell } from '../../services/api'
import { Against, Measured, MetricTip } from './parts'
import { count, hhmm, minutes, pct, usePoll } from './format'
import './monitor.css'

const FACET_KEY = 'vigil.fleetWall.facet'
const STATE_WORD: Record<WallCell['state'], string> = {
  needs_you: 'Needs you',
  running: 'Running',
  paused: 'Paused',
  waiting: 'Waiting for a run',
}

function readFacet(): string {
  try {
    return sessionStorage.getItem(FACET_KEY) ?? 'all'
  } catch {
    return 'all'
  }
}

function matches(cell: WallCell, facet: string): boolean {
  switch (facet) {
    case 'all':
      return true
    case 'near_limit':
      return cell.near_limit
    case 'combined':
      return cell.combined
    case 'single':
      return !cell.combined
    default:
      return cell.state === facet
  }
}

function slaText(seconds: number | null): string {
  if (seconds == null) return 'No SLA'
  if (seconds < 0) return `Breached ${minutes(-seconds / 60)} ago`
  return `${minutes(seconds / 60)} left`
}

function hoverLine(cell: WallCell, workflow: string): string {
  return [
    `Case ${cell.case_id} · ${cell.title}`,
    `${workflow} · ${STATE_WORD[cell.state]}: ${cell.reason}`,
    `Severity ${cell.severity ?? 'not set'} · ${cell.alerts} alert${cell.alerts === 1 ? '' : 's'} combined`,
    `Limit used ${cell.limit_used == null ? 'not priced' : pct(cell.limit_used)} · ${cell.steps ?? 0} steps`,
  ].join('\n')
}

export default function FleetWallScreen({ go, openCase }: ConsoleScreenProps) {
  const { data, phase, reload } = usePoll<FleetWallPayload>(monitorApi.wall, 10_000)
  const [facet, setFacet] = useState<string>(readFacet)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    try {
      sessionStorage.setItem(FACET_KEY, facet)
    } catch {
      // A browser that refuses storage keeps the facet for this view only.
    }
  }, [facet])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!data) {
    return (
      <div className="mn-screen">
        {phase === 'error' ? (
          <EmptyState error icon="alert" title="Couldn’t load the Fleet Wall" body="The read failed; it is tried again every 10 s." primary={{ label: 'Retry', onClick: reload, icon: 'refresh' }} />
        ) : (
          <EmptyState loading icon="wall" title="Loading the Fleet Wall…" />
        )}
      </div>
    )
  }

  const cells = data.bands.flatMap((band) => (band.cells ?? []).map((cell) => ({ cell, band: band.name })))
  const chosen = cells.find((entry) => entry.cell.case_id === selected) ?? null
  const slots = data.slots
  const closed = data.closed_today
  const pace = closed.value != null ? closed.value - closed.yesterday : null

  return (
    <div className="mn-screen mn-wall">
      <header className="mn-head">
        <h1>Fleet Wall</h1>
        <p>Every open case, live, grouped by kind of work. The cases that need a person come first.</p>
      </header>

      {data.next_action && (
        <div className="mn-banner" role="status">
          <span className="mn-mark poor" aria-hidden="true">!</span>
          <span>
            <b>{data.next_action.count} case{data.next_action.count === 1 ? ' is' : 's are'} waiting on you</b> (red squares). Each one says why it stopped. Everything else is running inside its limits.
          </span>
          <span className="mn-banner-actions">
            {data.next_action.case_id && (
              <button type="button" className="mn-primary" onClick={() => openCase(data.next_action!.case_id!)}>Review the first one</button>
            )}
            <button type="button" className="mn-link" onClick={() => go('home')}>Open Needs you</button>
          </span>
        </div>
      )}

      <section className="mn-card mn-strip">
        <div className="mn-strip-slots">
          <div className="mn-gauge-head">
            <span>Slots in use</span>
            <MetricTip label="Slots in use" metric={slots} limit={slots.limit ? `${slots.limit} cases running at once` : 'No concurrency cap is set'} />
          </div>
          <div className="mn-big">
            {count(slots.value)}
            <small>{slots.limit ? ` of ${count(slots.limit)}` : ' · no cap set'}</small>
            <LevelBadge level={slots.level} variant="pill" />
          </div>
        </div>
        <div className="mn-strip-bar">
          <Against metric={slots} label="Slots in use against the cap" />
          <div className="mn-sub">
            {count(slots.value)} running · {count(slots.near_limit)} near their limit
            {data.load.value != null && ` · ${count(data.load.value)} alerts queued at intake${data.load.limit ? ` of ${count(data.load.limit)}` : ''}`}
          </div>
        </div>
        <div className="mn-strip-closed">
          <div className="mn-gauge-head">
            <span>Closed today</span>
            <MetricTip label="Closed today" metric={closed} limit="No target: pace against yesterday, without a goal" />
          </div>
          <div className="mn-big">
            {count(closed.value)}
            {pace != null && <small className={pace >= 0 ? 'good' : 'fair'}>{` ${pace >= 0 ? '+' : ''}${pace} vs yesterday`}</small>}
          </div>
          <div className="mn-sub">
            {closed.without_person != null ? `${pct(closed.without_person)} without a person` : 'None closed yet today'} · Incidents: <Measured metric={data.incidents_today} render={count} />
          </div>
        </div>
      </section>

      <div className="mn-facets" role="group" aria-label="Filter by state">
        <span className="mn-muted">Filter by state</span>
        {data.facets.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`mn-facet${facet === f.key ? ' active' : ''}`}
            disabled={f.count == null}
            title={f.unmeasured_reason ?? undefined}
            aria-pressed={facet === f.key}
            onClick={() => setFacet(f.key)}
          >
            <span className={`mn-swatch sw-${f.key}`} aria-hidden="true" />
            {f.label}
            <span className="num">{f.count == null ? '—' : count(f.count)}</span>
          </button>
        ))}
      </div>

      <div className="mn-legend">
        <span>
          <b>Each square is one open case.</b> Click one to see the case and what you can do with it.
        </span>
        <span className="mn-muted">
          Thick outline: 5 or more alerts <InfoTip label="How the squares are drawn" calculation={data.info.cell} align="end" />
        </span>
        <span className="mn-muted">
          Percentages: closed without a person today <InfoTip label="How the bands are calculated" calculation={data.info.kind} align="end" />
        </span>
      </div>

      {data.bands.length === 0 ? (
        <EmptyState icon="wall" title="No open cases" body="Every case is closed. New cases appear here as triage forms them." />
      ) : (
        <div className="mn-bands">
          {data.bands.map((band) => (
            <section key={band.workflow_id} className="mn-card mn-band">
              <div className="mn-band-head">
                <div className="mn-band-title">
                  <b>{band.name}</b>
                  {band.without_person.value != null && (
                    <span className={`mn-rate-word ${band.without_person.level ?? ''}`}>{pct(band.without_person.value)} without a person</span>
                  )}
                </div>
                <div className="mn-sub">
                  <b className="num">{count(band.open)}</b> open · <b className="num">{count(band.running.value)}</b> running
                </div>
                <div className="mn-sub" title={String(band.running.cap_text ?? '')}>
                  {count(band.today)} runs today · {count(band.waiting)} waiting
                </div>
              </div>
              <div className="mn-cells" role="list">
                {(band.cells ?? []).map((cell) => {
                  const shown = matches(cell, facet)
                  return (
                    <button
                      key={cell.case_id}
                      type="button"
                      role="listitem"
                      className={[
                        'mn-cell',
                        cell.state,
                        cell.heavy ? 'heavy' : '',
                        cell.near_limit ? 'near' : '',
                        selected === cell.case_id ? 'selected' : '',
                        shown ? '' : 'dim',
                      ].filter(Boolean).join(' ')}
                      title={hoverLine(cell, band.name)}
                      aria-label={`Case ${cell.case_id}, ${STATE_WORD[cell.state]}`}
                      onClick={() => setSelected(cell.case_id === selected ? null : cell.case_id)}
                    >
                      {cell.limit_used != null && <span className="mn-cell-fill" style={{ height: `${Math.min(100, cell.limit_used * 100)}%` }} />}
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
          {data.omitted > 0 && <p className="mn-muted">{count(data.omitted)} more open cases are not drawn.</p>}
        </div>
      )}

      {data.just_closed.length > 0 && (
        <section className="mn-closed">
          <span className="mn-muted">Just closed · last {data.just_closed_minutes} min</span>
          {data.just_closed.map((row) => (
            <button key={row.case_id} type="button" className="mn-closed-chip" onClick={() => openCase(row.case_id)}>
              <span className="mono">{row.case_id}</span> {hhmm(row.closed_at)} by {row.by}
            </button>
          ))}
        </section>
      )}

      {chosen && (
        <section className={`mn-card mn-select ${chosen.cell.state}`} aria-label={`Selected case ${chosen.cell.case_id}`}>
          <div className="mn-select-top">
            <span className={`mn-swatch sw-${chosen.cell.state}`} aria-hidden="true" />
            <span>
              Selected square: case <span className="mono">{chosen.cell.case_id}</span>
            </span>
            <span className="mn-muted">Click another square to switch, or press Esc to clear</span>
            <button type="button" className="mn-close" aria-label="Clear the selection" onClick={() => setSelected(null)}>×</button>
          </div>
          <div className="mn-select-main">
            <div>
              <b className="mn-select-title">{chosen.cell.title}</b>
              <div className={`mn-select-why ${chosen.cell.state}`}>
                {chosen.band} · {STATE_WORD[chosen.cell.state]}: {chosen.cell.reason}
              </div>
              {chosen.cell.description && <p className="mn-select-desc">{chosen.cell.description}</p>}
            </div>
            <div className="mn-select-actions">
              <button type="button" className="mn-primary" onClick={() => openCase(chosen.cell.case_id)}>
                {chosen.cell.state === 'needs_you' ? 'Decide in the case' : 'Open the case'}
              </button>
            </div>
          </div>
          <dl className="mn-select-grid">
            <div><dt>Limit used</dt><dd className={chosen.cell.limit_level ?? ''}>{chosen.cell.limit_used == null ? 'Not priced' : pct(chosen.cell.limit_used)}</dd></div>
            <div><dt>Steps taken</dt><dd>{chosen.cell.steps ?? 0}</dd></div>
            <div><dt>Alerts grouped</dt><dd>{chosen.cell.alerts}</dd></div>
            <div><dt>Severity</dt><dd className={`sev ${chosen.cell.severity ?? ''}`}>{chosen.cell.severity ?? 'Not set'}</dd></div>
            <div><dt>SLA</dt><dd>{slaText(chosen.cell.sla_seconds_left)}</dd></div>
            <div><dt>Owner</dt><dd>{chosen.cell.owner ?? 'Agents'}</dd></div>
          </dl>
          <p className="mn-muted">Hold and close from the wall are not built yet; both are on the case page.</p>
        </section>
      )}
    </div>
  )
}
