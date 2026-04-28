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
    .rate-annotation {
      font-size: 11px;
      color: var(--secondary-text-color);
      margin-top: 2px;
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
      'Radio · live': [],
      'Radio · configuration': [],
      'Traffic · totals': [],
      'Status': [],
      'Identity': [],
    };
    // Power group is intentionally absent — battery and voltage are
    // shown in the Battery hero tile (% as primary, voltage as secondary
    // alongside). Duplicating them as table rows just makes the card
    // taller without adding information.

    const consumed = new Set<string>();

    // Build composite rows first; they consume their component entities.
    const trafficRows = this._buildTrafficRows(consumed);
    if (trafficRows.length) groups['Traffic · totals'].push(...trafficRows);

    const radioCompositeRows = this._buildRadioCompositeRows(consumed);
    if (radioCompositeRows.length) {
      groups['Radio · live'].push(...radioCompositeRows);
    }

    for (const e of this.entities) {
      if (consumed.has(e.entity_id)) continue;
      if (this._isHeroDuplicate(e)) continue;
      const group = this._groupOf(e);
      groups[group].push(this._renderRow(e));
    }

    return (Object.entries(groups) as [GroupName, TemplateResult[]][])
      .filter(([, rows]) => rows.length > 0)
      .map(([name, rows]) => ({ name, rows }));
  }

  /** Return true for entities whose value is already shown in the hero
   *  row or in the device header status badge. Filtering here keeps the
   *  table tight without losing the entity from hidden-sensors-modal
   *  visibility (it's still in `this.entities`, just not rendered). */
  private _isHeroDuplicate(info: EntityInfo): boolean {
    // Battery percentage — primary value in Battery hero tile.
    if (info.metricKey === 'battery_pct') return true;
    // Battery voltage — secondary value alongside battery % in hero.
    // Other voltage channels (Ch1 Voltage etc.) stay in Status.
    if (info.entity_id.includes('battery_voltage')) return true;
    // SNR / RSSI — shown in Last message strength hero tile.
    if (info.metricKey === 'snr' || info.metricKey === 'rssi') return true;
    // Uptime — promoted to the device header status badge ("Online · 12d 19h").
    if (info.metricKey === 'uptime_hours') return true;
    return false;
  }

  private _groupOf(info: EntityInfo): GroupName {
    const eid = info.entity_id;
    const so = info.sortOrder;

    // Power group dropped. Battery (1) is hero-filtered; voltages (2) go
    // to Status (battery_voltage is hero-filtered, leaving Ch1 Voltage etc.).
    if (so === 2) return 'Status';
    if (so === 6) return 'Radio · configuration';
    if (so === 4 || so === 5 || so === 9 || so === 10 || so === 11 || so === 12)
      return 'Radio · live';
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
    const ev = info.metricKey ? this._evaluateForRow(info.metricKey, value, info) : null;
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
  private _evaluateForRow(key: MetricKey, raw: number, info: EntityInfo): SensorEval {
    if (key === 'uptime_hours') {
      // The integration's uptime sensor unit varies — the home install
      // reports days (`d`) per the duration device_class default, but
      // some flavours report seconds. Convert based on the live unit.
      const unit = (this.hass?.states[info.entity_id]?.attributes
                    ?.unit_of_measurement as string) ?? '';
      let hours = raw;
      switch (unit) {
        case 'd':   hours = raw * 24; break;
        case 'h':   hours = raw; break;
        case 'min': hours = raw / 60; break;
        case 's':
        default:    hours = raw / 3600; break;
      }
      return evaluateSensor(key, hours);
    }
    return evaluateSensor(key, raw);
  }

  // ─── Radio composite rows ─────────────────────────────────────────────

  /** Build the two stacked-bar rows in Radio · live:
   *  - Airtime (cumulative): TX / RX as % of total uptime.
   *  - Airtime utilization (windowed): the latest reporting interval's
   *    TX / RX util sum to ≤ 100% with idle filling the rest.
   *  Both consume their component entities so the table doesn't show
   *  the four individual airtime rows separately. */
  private _buildRadioCompositeRows(consumed: Set<string>): TemplateResult[] {
    const rows: TemplateResult[] = [];

    // ─── Cumulative airtime as % of uptime ─────────────────────────────
    const airtimeRaw = this._findEntityByLabel('Airtime');
    const rxAirtimeRaw = this._findEntityByLabel('RX Airtime');
    const uptime = this._findByMetric('uptime_hours');

    if ((airtimeRaw || rxAirtimeRaw) && uptime) {
      const txSec = airtimeRaw
        ? this._timeValueInSeconds(airtimeRaw.entity_id)
        : 0;
      const rxSec = rxAirtimeRaw
        ? this._timeValueInSeconds(rxAirtimeRaw.entity_id)
        : 0;
      const upSec = this._timeValueInSeconds(uptime.entity_id);

      if (Number.isFinite(upSec) && upSec > 0) {
        const txPct = Math.max(0, (txSec / upSec) * 100);
        const rxPct = Math.max(0, (rxSec / upSec) * 100);
        const idlePct = Math.max(0, 100 - txPct - rxPct);

        const segs: StackedBarSegment[] = [
          { value: txPct,   label: `TX ${txPct.toFixed(2)}%`,   kind: 'tx' },
          { value: rxPct,   label: `RX ${rxPct.toFixed(2)}%`,   kind: 'rx' },
          { value: idlePct, label: `Idle ${idlePct.toFixed(1)}%`, kind: 'idle' },
        ];

        // Use the worse of the two band classifications for the dot.
        const band = this._worseBand(
          evaluateSensor('tx_airtime_util', txPct).band,
          evaluateSensor('rx_airtime_util', rxPct).band,
        );

        rows.push(html`
          <tr class="data-row stacked-row"
              @click=${() => airtimeRaw && this._fireMoreInfo(airtimeRaw.entity_id)}>
            <td class="col-status">
              <span class="status-dot ${band}"></span>
            </td>
            <td class="col-label">
              Airtime
              ${this._renderInfoTip({
                band,
                fillPct: 0,
                tooltip:
                  'Cumulative TX and RX airtime as a percentage of total ' +
                  'uptime. Bar represents 100% of uptime; segments are TX, ' +
                  'RX, and idle.',
              })}
            </td>
            <td class="col-value">${(txPct + rxPct).toFixed(2)}%</td>
            <td class="col-bar">
              <meshcore-stacked-bar
                .segments=${segs}
                .total=${100}
                .legend=${'inline'}>
              </meshcore-stacked-bar>
            </td>
          </tr>
        `);

        if (airtimeRaw) consumed.add(airtimeRaw.entity_id);
        if (rxAirtimeRaw) consumed.add(rxAirtimeRaw.entity_id);
      }
    }

    // ─── Windowed airtime utilization (TX util + RX util + Idle = 100) ──
    const txUtil = this._findByMetric('tx_airtime_util');
    const rxUtil = this._findByMetric('rx_airtime_util');
    if (txUtil || rxUtil) {
      const txN = txUtil ? this._readNumber(txUtil.entity_id) : NaN;
      const rxN = rxUtil ? this._readNumber(rxUtil.entity_id) : NaN;
      const txF = Number.isFinite(txN) ? Math.max(0, txN) : 0;
      const rxF = Number.isFinite(rxN) ? Math.max(0, rxN) : 0;
      const idleF = Math.max(0, 100 - txF - rxF);

      const segs: StackedBarSegment[] = [
        { value: txF,   label: `TX ${txF.toFixed(1)}%`,   kind: 'tx' },
        { value: rxF,   label: `RX ${rxF.toFixed(1)}%`,   kind: 'rx' },
        { value: idleF, label: `Idle ${idleF.toFixed(1)}%`, kind: 'idle' },
      ];

      const band = this._worseBand(
        evaluateSensor('tx_airtime_util', txF).band,
        evaluateSensor('rx_airtime_util', rxF).band,
      );

      rows.push(html`
        <tr class="data-row stacked-row"
            @click=${() => txUtil && this._fireMoreInfo(txUtil.entity_id)}>
          <td class="col-status">
            <span class="status-dot ${band}"></span>
          </td>
          <td class="col-label">
            Airtime utilization
            ${this._renderInfoTip({
              band,
              fillPct: 0,
              tooltip:
                'Windowed TX and RX airtime utilization over the last ' +
                'reporting interval. Bar segments sum to ≤ 100%; idle ' +
                'fills the rest.',
            })}
          </td>
          <td class="col-value">${(txF + rxF).toFixed(1)}%</td>
          <td class="col-bar">
            <meshcore-stacked-bar
              .segments=${segs}
              .total=${100}
              .legend=${'inline'}>
            </meshcore-stacked-bar>
          </td>
        </tr>
      `);

      if (txUtil) consumed.add(txUtil.entity_id);
      if (rxUtil) consumed.add(rxUtil.entity_id);
    }

    return rows;
  }

  /** Read a sensor's state value and convert via its unit_of_measurement
   *  attribute to seconds. Used for the cumulative airtime composite. */
  private _timeValueInSeconds(entityId: string): number {
    const raw = this._readNumber(entityId);
    if (!Number.isFinite(raw)) return NaN;
    const unit = (this.hass?.states[entityId]?.attributes
                  ?.unit_of_measurement as string) ?? 's';
    switch (unit) {
      case 'd':   return raw * 86400;
      case 'h':   return raw * 3600;
      case 'min': return raw * 60;
      case 's':
      default:    return raw;
    }
  }

  /** Read a *_rate sensor's state directly from hass.states (rate sensors
   *  are excluded from `this.entities` by classify-entity, so we derive
   *  the rate entity_id from the totals entity_id by inserting `_rate`
   *  before the device-name suffix). Returns NaN if not present. */
  private _readDerivedRate(totalsEid: string, key: string): number {
    // entity_id pattern: sensor.meshcore_<prefix>_<key>_<device-suffix>
    // rate variant:     sensor.meshcore_<prefix>_<key>_rate_<device-suffix>
    const rateEid = totalsEid.replace(`_${key}_`, `_${key}_rate_`);
    if (!this.hass?.states[rateEid]) return NaN;
    const s = this.hass.states[rateEid].state;
    if (s === 'unavailable' || s === 'unknown') return NaN;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
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
      const sentRate = this._readDerivedRate(nbSent.entity_id, 'nb_sent');
      rows.push(this._renderTrafficRow(
        'Messages sent',
        totalSent,
        segs,
        Number.isFinite(sentRate) ? `${sentRate.toFixed(1)} msg/min` : undefined,
      ));
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

      const recvRate = this._readDerivedRate(nbRecv.entity_id, 'nb_recv');
      const recvRateAnnotation = Number.isFinite(recvRate)
        ? `${recvRate.toFixed(1)} msg/min`
        : undefined;

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
            ${recvRateAnnotation
              ? html`<div class="rate-annotation">${recvRateAnnotation}</div>`
              : nothing}
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
    rateAnnotation?: string,
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
          ${rateAnnotation
            ? html`<div class="rate-annotation">${rateAnnotation}</div>`
            : nothing}
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
