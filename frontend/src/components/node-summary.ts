import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { HomeAssistant, ManagedDevice } from '../types';
import type { EntityInfo } from '../utils/classify-entity';
import {
  evaluateSensor,
  type Band,
  type MetricKey,
  type SensorEval,
} from '../utils/sensor-thresholds';
import { longPress } from '../directives/long-press';
import './stat-bar';
import './stacked-bar';
import './info-tip';
import type { StackedBarSegment } from './stacked-bar';

/**
 * Synthesized device descriptor for the Settings tab's companion device.
 * The companion's underlying type is `MeshCoreDevice` (see types.ts) which
 * doesn't share a shape with `ManagedDevice`; the page-level adapter wraps
 * it into this descriptor so node-summary's discriminated-union switch
 * works uniformly.
 */
export interface CompanionDeviceDescriptor {
  type: 'companion';
  name: string;
  pubkey_prefix: string;
  connected: boolean;
  firmware?: string;
  entry_id?: string;
}

export type NodeSummaryDevice = ManagedDevice | CompanionDeviceDescriptor;

type GroupName =
  | 'Power'
  | 'Radio · live'
  | 'Radio · configuration'
  | 'Traffic · totals'
  | 'Status'
  | 'Identity';

/**
 * Aggregated card body used by the Devices and Settings tabs in place of
 * the prior flat tile grid. Pairs a "hero row" of headline values with a
 * categorised, threshold-banded table of every other meshcore sensor on
 * the node.
 *
 * Layout per node type:
 *  - Repeater: 4-tile hero row (Battery / Last message strength /
 *    Radio activity / Location); every Power/Radio/Traffic/Status group
 *    that has any sensors renders.
 *  - Client: 3-tile hero row (Battery / Last message strength / Location);
 *    only the Status group renders below.
 *  - Companion: 3-tile hero row (Mesh node count / Location / Power);
 *    Radio · configuration is the dominant table group.
 *
 * The component owns the hero row, the table, and the (N hidden) suffix.
 * It does NOT own the outer .device-section wrapper, the header (icon +
 * name + meta + status badge), or the actions row — those continue to
 * live in devices-page.ts and settings-page.ts so the per-page differences
 * (icon glyph, action handlers) stay where they belong.
 *
 * Click on any row fires `hass-more-info` so the existing entity-deep-link
 * UX is preserved. Long-press fires `tile-context-menu` so the existing
 * sensor-hide flow is preserved.
 */
@customElement('meshcore-node-summary')
export class NodeSummary extends LitElement {
  @property({ type: Object }) hass?: HomeAssistant;
  @property({ type: Object }) device?: NodeSummaryDevice;
  @property({ type: Array }) entities: EntityInfo[] = [];
  @property({ type: Number }) hiddenCount = 0;

  static styles = css`
    :host { display: block; }

    /* ─── Hero row ─── */
    .hero-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .hero-tile {
      background: var(--secondary-background-color, #f0f0f0);
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: border-color 0.15s;
    }
    .hero-tile:hover { border-color: var(--primary-color, #03a9f4); }
    .hero-tile-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--secondary-text-color);
    }
    .hero-tile-value {
      display: flex;
      align-items: baseline;
      gap: 6px;
      flex-wrap: wrap;
    }
    .hero-tile-value .primary {
      font-size: 22px;
      font-weight: 600;
      color: var(--primary-text-color);
      line-height: 1;
    }
    .hero-tile-value .secondary {
      font-size: 13px;
      color: var(--secondary-text-color);
    }
    .hero-tile-value .compact {
      font-size: 14px;
      font-weight: 500;
      color: var(--primary-text-color);
    }

    /* ─── Status dots ─── */
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      display: inline-block;
    }
    .status-dot.good { background: var(--good, #4caf50); }
    .status-dot.warn { background: var(--warn, #ff9800); }
    .status-dot.bad  { background: var(--bad,  #f44336); }
    .status-dot.info { background: var(--info, #2196f3); }

    /* ─── Subsection label ─── */
    .subsection-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--secondary-text-color);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      margin-top: 16px;
    }
    .hidden-suffix {
      font-weight: 400;
      text-transform: none;
      opacity: 0.6;
      margin-left: 6px;
    }

    /* ─── Sensor table ─── */
    .sensor-table {
      width: 100%;
      border-collapse: collapse;
    }
    .sensor-table tbody tr.data-row {
      border-top: 1px solid var(--divider-color);
    }
    .sensor-table tbody tr.data-row:first-child { border-top: none; }
    .sensor-table tbody tr.data-row:hover {
      background: rgba(127, 127, 127, 0.06);
      cursor: pointer;
    }
    .sensor-table td {
      padding: 8px 6px;
      vertical-align: middle;
      font-size: 13px;
    }
    .col-status { width: 14px; padding-left: 4px; padding-right: 0; }
    .col-label  { width: 36%; color: var(--secondary-text-color); }
    .col-value  {
      width: 22%;
      color: var(--primary-text-color);
      font-weight: 500;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .col-bar    { padding-left: 12px; padding-right: 0; }
    .col-bar meshcore-stat-bar { width: 100%; min-width: 80px; }

    .group-row td {
      padding: 12px 4px 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--secondary-text-color);
      border-top: none !important;
    }
    .group-row + tr.data-row { border-top: none !important; }

    .stacked-row td.col-bar { padding-top: 6px; padding-bottom: 6px; }

    .unit {
      font-size: 11px;
      font-weight: 400;
      color: var(--secondary-text-color);
      margin-left: 2px;
    }

    .map-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 12px;
      background: var(--info-bg, rgba(33, 150, 243, 0.18));
      color: var(--info, #2196f3);
      font-size: 11px;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
    }
    .coord-pair {
      font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      font-size: 13px;
      color: var(--primary-text-color);
    }

    .dup-annotation {
      font-size: 11px;
      color: var(--secondary-text-color);
      font-style: italic;
      margin-top: 2px;
    }
    .dup-annotation .num {
      font-weight: 500;
      color: var(--warn, #ff9800);
    }
  `;

  // ─── Render ────────────────────────────────────────────────────────────

  render() {
    if (!this.hass || !this.device) return nothing;
    const groups = this._buildGroups();

    return html`
      <div class="hero-row">
        ${this._renderHeroTiles()}
      </div>

      <div class="subsection-label">
        Sensors${this.hiddenCount > 0
          ? html`<span class="hidden-suffix">(${this.hiddenCount} hidden)</span>`
          : nothing}
      </div>

      <table class="sensor-table">
        <tbody>
          ${groups.map((g) => this._renderGroup(g))}
        </tbody>
      </table>
    `;
  }

  // ─── Hero row variants ────────────────────────────────────────────────

  private _renderHeroTiles(): TemplateResult | typeof nothing {
    const dev = this.device!;
    if (dev.type === 'companion') return this._renderCompanionHero();
    if (dev.type === 'repeater') return this._renderRepeaterHero();
    return this._renderClientHero();
  }

  private _renderRepeaterHero() {
    return html`
      ${this._renderBatteryTile()}
      ${this._renderSignalTile()}
      ${this._renderRadioActivityTile()}
      ${this._renderLocationTile()}
    `;
  }

  private _renderClientHero() {
    return html`
      ${this._renderBatteryTile()}
      ${this._renderSignalTile()}
      ${this._renderLocationTile()}
    `;
  }

  private _renderCompanionHero() {
    return html`
      ${this._renderMeshNodeCountTile()}
      ${this._renderLocationTile()}
      ${this._renderCompanionPowerTile()}
    `;
  }

  private _renderBatteryTile() {
    const battery = this._findByMetric('battery_pct');
    if (!battery) return nothing; // mains-powered node — omit tile (Q3)
    const pct = this._readNumber(battery.entity_id);
    const voltage = this._findEntityIdMatching('battery_voltage') ?? this._findEntityByLabel('Voltage');
    const voltageVal = voltage ? this._readNumber(voltage.entity_id) : NaN;
    const ev = evaluateSensor('battery_pct', pct);

    return html`
      <div class="hero-tile" @click=${() => this._fireMoreInfo(battery.entity_id)}>
        <div class="hero-tile-head">
          <span>Battery${this._renderInfoTip(ev)}</span>
          <span class="status-dot ${ev.band}"></span>
        </div>
        <div class="hero-tile-value">
          <span class="primary">
            ${this._formatNumber(pct, 0)}<span class="unit">%</span>
          </span>
          ${Number.isFinite(voltageVal)
            ? html`<span class="secondary">· ${voltageVal.toFixed(3)} V</span>`
            : nothing}
        </div>
        <meshcore-stat-bar
          .value=${pct}
          .min=${0}
          .max=${100}
          .band=${ev.band}>
        </meshcore-stat-bar>
      </div>
    `;
  }

  private _renderSignalTile() {
    const rssi = this._findByMetric('rssi');
    if (!rssi) return nothing;
    const rssiVal = this._readNumber(rssi.entity_id);
    const snr = this._findByMetric('snr');
    const snrVal = snr ? this._readNumber(snr.entity_id) : NaN;
    const ev = evaluateSensor('rssi', rssiVal);

    return html`
      <div class="hero-tile" @click=${() => this._fireMoreInfo(rssi.entity_id)}>
        <div class="hero-tile-head">
          <span>Last message strength${this._renderInfoTip(ev)}</span>
          <span class="status-dot ${ev.band}"></span>
        </div>
        <div class="hero-tile-value">
          <span class="primary">
            ${this._formatNumber(rssiVal, 0)}<span class="unit">dBm</span>
          </span>
          ${Number.isFinite(snrVal)
            ? html`<span class="secondary">· SNR ${snrVal.toFixed(1)} dB</span>`
            : nothing}
        </div>
        <meshcore-stat-bar
          .value=${rssiVal}
          .min=${-130}
          .max=${-30}
          .band=${ev.band}>
        </meshcore-stat-bar>
      </div>
    `;
  }

  private _renderRadioActivityTile() {
    const tx = this._findByMetric('tx_airtime_util');
    const rx = this._findByMetric('rx_airtime_util');
    if (!tx && !rx) return nothing;
    const txVal = tx ? this._readNumber(tx.entity_id) : 0;
    const rxVal = rx ? this._readNumber(rx.entity_id) : 0;
    const txN = Number.isFinite(txVal) ? Math.max(0, txVal) : 0;
    const rxN = Number.isFinite(rxVal) ? Math.max(0, rxVal) : 0;
    const idleN = Math.max(0, 100 - txN - rxN);

    // Use the worse of the two airtime bands as the dot.
    const txBand = evaluateSensor('tx_airtime_util', txN).band;
    const rxBand = evaluateSensor('rx_airtime_util', rxN).band;
    const dotBand: Band = this._worseBand(txBand, rxBand);

    const segments: StackedBarSegment[] = [
      { value: txN, label: `TX ${txN.toFixed(1)}%`, kind: 'tx' },
      { value: rxN, label: `RX ${rxN.toFixed(1)}%`, kind: 'rx' },
      { value: idleN, label: `Idle ${idleN.toFixed(1)}%`, kind: 'idle' },
    ];

    return html`
      <div class="hero-tile"
           @click=${() => tx && this._fireMoreInfo(tx.entity_id)}>
        <div class="hero-tile-head">
          <span>Radio activity${this._renderInfoTip({
            band: dotBand,
            fillPct: 0,
            tooltip: 'Half-duplex composition over the last reporting interval. ' +
                     'The radio can transmit OR receive, never both. TX above 10% ' +
                     'indicates duty-cycle pressure; sustained TX+RX above 30% ' +
                     'means the channel is congested.',
          })}</span>
          <span class="status-dot ${dotBand}"></span>
        </div>
        <div class="hero-tile-value">
          <span class="compact">
            TX ${txN.toFixed(1)}% · RX ${rxN.toFixed(1)}% · Idle ${idleN.toFixed(1)}%
          </span>
        </div>
        <meshcore-stacked-bar
          .segments=${segments}
          .total=${100}
          .legend=${'none'}>
        </meshcore-stacked-bar>
      </div>
    `;
  }

  private _renderLocationTile() {
    const lat = this._findEntityIdMatching('latitude');
    const lon = this._findEntityIdMatching('longitude');
    const latVal = lat ? this._readNumber(lat.entity_id) : NaN;
    const lonVal = lon ? this._readNumber(lon.entity_id) : NaN;
    const hasGps = Number.isFinite(latVal) && Number.isFinite(lonVal)
                   && (latVal !== 0 || lonVal !== 0);

    return html`
      <div class="hero-tile"
           @click=${() => lat && this._fireMoreInfo(lat.entity_id)}>
        <div class="hero-tile-head">
          <span>Location</span>
        </div>
        <div class="hero-tile-value">
          ${hasGps
            ? html`<span class="coord-pair">
                ${latVal.toFixed(4)}, ${lonVal.toFixed(4)}
              </span>`
            : html`<span class="primary">—</span>`}
        </div>
      </div>
    `;
  }

  private _renderMeshNodeCountTile() {
    const nodeCount = this._findEntityIdMatching('node_count');
    const val = nodeCount ? this._readNumber(nodeCount.entity_id) : NaN;
    return html`
      <div class="hero-tile"
           @click=${() => nodeCount && this._fireMoreInfo(nodeCount.entity_id)}>
        <div class="hero-tile-head"><span>Mesh nodes</span></div>
        <div class="hero-tile-value">
          <span class="primary">${Number.isFinite(val) ? val : '—'}</span>
        </div>
      </div>
    `;
  }

  private _renderCompanionPowerTile() {
    const battery = this._findByMetric('battery_pct');
    if (battery) return this._renderBatteryTile();
    return html`
      <div class="hero-tile">
        <div class="hero-tile-head"><span>Power</span></div>
        <div class="hero-tile-value">
          <span class="primary" style="font-size:16px;">USB / mains</span>
        </div>
      </div>
    `;
  }

  // ─── Sensor table grouping ────────────────────────────────────────────

  private _buildGroups(): { name: GroupName; rows: TemplateResult[] }[] {
    const groups: Record<GroupName, TemplateResult[]> = {
      'Power': [],
      'Radio · live': [],
      'Radio · configuration': [],
      'Traffic · totals': [],
      'Status': [],
      'Identity': [],
    };

    // Track entity_ids consumed by composite Traffic rows so we don't
    // double-render them as individual rows below.
    const consumed = new Set<string>();
    const trafficRows = this._buildTrafficRows(consumed);
    if (trafficRows.length) groups['Traffic · totals'].push(...trafficRows);

    for (const e of this.entities) {
      if (consumed.has(e.entity_id)) continue;
      const group = this._groupOf(e);
      groups[group].push(this._renderRow(e));
    }

    return (Object.entries(groups) as [GroupName, TemplateResult[]][])
      .filter(([, rows]) => rows.length > 0)
      .map(([name, rows]) => ({ name, rows }));
  }

  private _groupOf(info: EntityInfo): GroupName {
    const eid = info.entity_id;
    const so = info.sortOrder;

    if (so === 1 || so === 2) return 'Power';
    if (so === 6) return 'Radio · configuration';
    if (so === 4 || so === 5 || so === 9 || so === 10) return 'Radio · live';
    if (eid.includes('noise_floor') || eid.includes('tx_queue')) return 'Radio · live';

    if (eid.includes('frequency') || eid.includes('bandwidth')
        || eid.includes('spreading_factor') || eid.includes('rate_limiter')) {
      return 'Radio · configuration';
    }

    if (eid.includes('hop_count') || eid.includes('out_path')
        || eid.includes('last_seen') || eid.includes('last_advert')
        || so === 3 || so === 8 || so === 7) {
      return 'Status';
    }

    return 'Identity';
  }

  private _renderGroup(g: { name: GroupName; rows: TemplateResult[] }) {
    return html`
      <tr class="group-row"><td colspan="4">${g.name}</td></tr>
      ${g.rows}
    `;
  }

  // ─── Sensor row ───────────────────────────────────────────────────────

  private _renderRow(info: EntityInfo) {
    const value = this._readNumber(info.entity_id);
    const stateObj = this.hass?.states[info.entity_id];
    const unit = (stateObj?.attributes?.unit_of_measurement as string) ?? '';
    const ev = info.metricKey ? this._evaluateForRow(info.metricKey, value) : null;
    const band = ev?.band ?? 'info';

    const formattedValue = this._formatRowValue(info, value, stateObj?.state);

    return html`
      <tr class="data-row"
          @click=${() => this._fireMoreInfo(info.entity_id)}
          @contextmenu=${(e: MouseEvent) => this._fireContextMenu(e, info)}
          ${longPress(() => this._fireContextMenu(undefined, info))}>
        <td class="col-status">
          <span class="status-dot ${band}"></span>
        </td>
        <td class="col-label">
          ${info.label}
          ${ev ? this._renderInfoTip(ev) : nothing}
        </td>
        <td class="col-value">
          ${formattedValue}${unit ? html`<span class="unit">${unit}</span>` : nothing}
        </td>
        <td class="col-bar">
          ${ev && info.metricKey
            ? html`<meshcore-stat-bar
                .value=${ev.fillPct}
                .min=${0}
                .max=${100}
                .band=${band}>
              </meshcore-stat-bar>`
            : nothing}
        </td>
      </tr>
    `;
  }

  /** Apply metric-specific unit conversion for evaluateSensor. */
  private _evaluateForRow(key: MetricKey, raw: number): SensorEval {
    if (key === 'uptime_hours') {
      // HA reports uptime in seconds via duration device_class.
      return evaluateSensor(key, raw / 3600);
    }
    return evaluateSensor(key, raw);
  }

  // ─── Traffic composite rows ───────────────────────────────────────────

  private _buildTrafficRows(consumed: Set<string>): TemplateResult[] {
    const rows: TemplateResult[] = [];

    // ─── Sent composition (flood + direct + other) ─────────────────────
    const nbSent = this._findEntityIdMatching('nb_sent');
    const sentFlood = this._findEntityIdMatching('sent_flood');
    const sentDirect = this._findEntityIdMatching('sent_direct');

    if (nbSent && (sentFlood || sentDirect)) {
      const totalSent = this._readNumber(nbSent.entity_id);
      const flood = sentFlood ? this._readNumber(sentFlood.entity_id) : 0;
      const direct = sentDirect ? this._readNumber(sentDirect.entity_id) : 0;
      const other = Math.max(0, totalSent - flood - direct);
      const segs: StackedBarSegment[] = [
        { value: flood,  label: `Flood ${flood}`,   kind: 'flood' },
        { value: direct, label: `Direct ${direct}`, kind: 'direct' },
        { value: other,  label: `Other ${other}`,   kind: 'other' },
      ];
      rows.push(this._renderTrafficRow('Messages sent', totalSent, segs));
      [nbSent, sentFlood, sentDirect].forEach((e) => e && consumed.add(e.entity_id));
    }

    // ─── Received composition + duplicate annotation ──────────────────
    const nbRecv = this._findEntityIdMatching('nb_recv');
    const recvFlood = this._findEntityIdMatching('recv_flood');
    const recvDirect = this._findEntityIdMatching('recv_direct');
    const floodDups = this._findEntityIdMatching('flood_dups');
    const directDups = this._findEntityIdMatching('direct_dups');

    if (nbRecv && (recvFlood || recvDirect)) {
      const totalRecv = this._readNumber(nbRecv.entity_id);
      const flood = recvFlood ? this._readNumber(recvFlood.entity_id) : 0;
      const direct = recvDirect ? this._readNumber(recvDirect.entity_id) : 0;
      const other = Math.max(0, totalRecv - flood - direct);
      const segs: StackedBarSegment[] = [
        { value: flood,  label: `Flood ${flood}`,   kind: 'flood' },
        { value: direct, label: `Direct ${direct}`, kind: 'direct' },
        { value: other,  label: `Other ${other}`,   kind: 'other' },
      ];

      const fdups = floodDups ? this._readNumber(floodDups.entity_id) : 0;
      const ddups = directDups ? this._readNumber(directDups.entity_id) : 0;
      const totalDups = (Number.isFinite(fdups) ? fdups : 0)
                      + (Number.isFinite(ddups) ? ddups : 0);
      const dupRatio = totalRecv > 0 ? (totalDups / totalRecv) * 100 : 0;
      const dupBand = evaluateSensor('duplicate_ratio', dupRatio).band;

      rows.push(html`
        <tr class="data-row stacked-row"
            @click=${() => this._fireMoreInfo(nbRecv.entity_id)}>
          <td class="col-status">
            <span class="status-dot info"></span>
          </td>
          <td class="col-label">Messages received</td>
          <td class="col-value">${totalRecv}</td>
          <td class="col-bar">
            <meshcore-stacked-bar
              .segments=${segs}
              .legend=${'inline'}>
            </meshcore-stacked-bar>
            ${totalDups > 0
              ? html`<div class="dup-annotation">
                  + <span class="num" style="color: var(--${dupBand})">
                    ${totalDups}
                  </span> duplicate${totalDups === 1 ? '' : 's'}
                  (${dupRatio.toFixed(1)}% of recv)
                </div>`
              : nothing}
          </td>
        </tr>
      `);
      [nbRecv, recvFlood, recvDirect, floodDups, directDups]
        .forEach((e) => e && consumed.add(e.entity_id));
    }

    // ─── Request success / failure ─────────────────────────────────────
    const successes = this._findEntityIdMatching('request_succ');
    const failures = this._findEntityIdMatching('request_fail');
    if (successes && failures) {
      const sVal = this._readNumber(successes.entity_id);
      const fVal = this._readNumber(failures.entity_id);
      const total = sVal + fVal;
      const rate = total > 0 ? (sVal / total) * 100 : 0;
      // Caller (us) is responsible for the 50-attempt min-sample floor.
      const ev = total >= 50
        ? evaluateSensor('request_success_rate', rate)
        : { band: 'info' as Band, fillPct: 0, tooltip: 'Insufficient samples (< 50 attempts).' };

      const segs: StackedBarSegment[] = [
        { value: sVal, label: `${sVal} ok`,    kind: 'success' },
        { value: fVal, label: `${fVal} fail`, kind: 'failure' },
      ];

      rows.push(html`
        <tr class="data-row stacked-row"
            @click=${() => this._fireMoreInfo(successes.entity_id)}>
          <td class="col-status">
            <span class="status-dot ${ev.band}"></span>
          </td>
          <td class="col-label">
            Requests
            ${this._renderInfoTip(ev as SensorEval)}
          </td>
          <td class="col-value">
            ${total > 0 ? `${rate.toFixed(0)}%` : '—'}
          </td>
          <td class="col-bar">
            <meshcore-stacked-bar
              .segments=${segs}
              .legend=${'inline'}>
            </meshcore-stacked-bar>
          </td>
        </tr>
      `);
      consumed.add(successes.entity_id);
      consumed.add(failures.entity_id);
    }

    return rows;
  }

  private _renderTrafficRow(
    label: string,
    total: number,
    segments: StackedBarSegment[],
  ) {
    return html`
      <tr class="data-row stacked-row">
        <td class="col-status">
          <span class="status-dot info"></span>
        </td>
        <td class="col-label">${label}</td>
        <td class="col-value">${Number.isFinite(total) ? total : '—'}</td>
        <td class="col-bar">
          <meshcore-stacked-bar
            .segments=${segments}
            .legend=${'inline'}>
          </meshcore-stacked-bar>
        </td>
      </tr>
    `;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private _findByMetric(key: MetricKey): EntityInfo | undefined {
    return this.entities.find((e) => e.metricKey === key);
  }

  private _findEntityIdMatching(substr: string): EntityInfo | undefined {
    return this.entities.find((e) => e.entity_id.includes(substr));
  }

  private _findEntityByLabel(label: string): EntityInfo | undefined {
    return this.entities.find((e) => e.label === label);
  }

  private _readNumber(entityId: string): number {
    const s = this.hass?.states[entityId];
    if (!s || s.state === 'unavailable' || s.state === 'unknown') return NaN;
    const n = parseFloat(s.state);
    return Number.isFinite(n) ? n : NaN;
  }

  private _formatNumber(value: number, precision: number): string {
    if (!Number.isFinite(value)) return '—';
    return value.toFixed(precision);
  }

  private _formatRowValue(info: EntityInfo, num: number, raw?: string): string {
    if (raw === 'unavailable' || raw === 'unknown') return '—';
    if (!Number.isFinite(num)) return raw ?? '—';

    const dp = this.hass?.entities?.[info.entity_id]?.display_precision;
    if (dp != null && dp >= 0) return num.toFixed(dp);
    if (raw && raw.includes('.')) return raw;
    return num.toString();
  }

  private _renderInfoTip(ev: SensorEval): TemplateResult | typeof nothing {
    if (!ev.tooltip) return nothing;
    return html`<meshcore-info-tip
      .content=${ev.tooltip}
      .source=${ev.source ?? ''}>
    </meshcore-info-tip>`;
  }

  private _worseBand(a: Band, b: Band): Band {
    const rank: Record<Band, number> = { good: 0, info: 0, warn: 1, bad: 2 };
    return rank[a] >= rank[b] ? a : b;
  }

  private _fireMoreInfo(entityId: string) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', {
      detail: { entityId },
      bubbles: true,
      composed: true,
    }));
  }

  private _fireContextMenu(e: MouseEvent | undefined, info: EntityInfo) {
    e?.preventDefault();
    this.dispatchEvent(new CustomEvent('tile-context-menu', {
      detail: { entityId: info.entity_id, label: info.label },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'meshcore-node-summary': NodeSummary;
  }
}
