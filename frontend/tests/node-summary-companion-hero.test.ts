// @vitest-environment happy-dom

// Phase 2 of the Companion Self-Diagnostic Sensors proposal: the Settings-tab
// companion card renders the same rich hero a managed repeater gets, sourced
// from the companion's self-diagnostic entities, and degrades to the prior
// minimal hero when those entities are absent (Self Diagnostics disabled
// upstream). These tests assert both states.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '../src/components/node-summary';
import { classifyEntity, type EntityInfo } from '../src/utils/classify-entity';
import type { CompanionDeviceDescriptor } from '../src/components/node-summary';
import type { HomeAssistant } from '../src/types';

const NODE = 'meshcore_1ed4c1_';
const SUFFIX = '_mattdub';

interface RawSpec {
  key: string;
  state: string;
  unit?: string;
  name?: string;
  domain?: string; // 'sensor' (default) or 'binary_sensor'
}

// The companion's always-present (non-diagnostic) entities. These exist
// regardless of the Self Diagnostics toggle.
const BASE: RawSpec[] = [
  { key: 'node_count', state: '6', name: 'Node Count' },
];

// A real GPS fix — the Location tile renders only when coordinates are
// present and non-zero.
const LOCATION: RawSpec[] = [
  { key: 'latitude', state: '34.0522', name: 'Latitude' },
  { key: 'longitude', state: '-118.2437', name: 'Longitude' },
];

// A 0,0 placeholder — the companion's "no fix" state. The Location tile
// must hide for this exactly as it does when the entities are absent.
const LOCATION_BLANK: RawSpec[] = [
  { key: 'latitude', state: '0.0', name: 'Latitude' },
  { key: 'longitude', state: '0.0', name: 'Longitude' },
];

// The entities created only when Self Diagnostics is enabled upstream, plus
// battery (battery-powered companion variant — exercises the no-double-draw
// guard on the battery slot).
const DIAGNOSTICS: RawSpec[] = [
  { key: 'battery_percentage', state: '90', unit: '%', name: 'Battery Percentage' },
  { key: 'battery_voltage', state: '4.1', unit: 'V', name: 'Battery Voltage' },
  { key: 'uptime', state: '0.705', unit: 'd', name: 'Uptime' },
  { key: 'tx_queue_len', state: '0', name: 'TX Queue Length' },
  { key: 'noise_floor', state: '-110', unit: 'dBm', name: 'Noise Floor' },
  { key: 'last_rssi', state: '-52', unit: 'dBm', name: 'Last RSSI' },
  { key: 'last_snr', state: '11.75', unit: 'dB', name: 'Last SNR' },
  { key: 'tx_airtime', state: '0.3', unit: 'min', name: 'TX Airtime' },
  { key: 'rx_airtime', state: '22.3', unit: 'min', name: 'RX Airtime' },
  { key: 'nb_recv', state: '3272', name: 'Messages Received' },
  { key: 'nb_sent', state: '115', name: 'Messages Sent' },
  { key: 'sent_flood', state: '14', name: 'Sent Flood Messages' },
  { key: 'sent_direct', state: '101', name: 'Sent Direct Messages' },
  { key: 'recv_flood', state: '3188', name: 'Received Flood Messages' },
  { key: 'recv_direct', state: '84', name: 'Received Direct Messages' },
  { key: 'recv_errors', state: '638', name: 'Receive Errors' },
  // Decoded radio fault flags (problem binary_sensors). One Detected, two OK.
  { key: 'err_pool_full', state: 'on', domain: 'binary_sensor', name: 'Radio Fault: Packet Pool Exhausted' },
  { key: 'err_cad_timeout', state: 'off', domain: 'binary_sensor', name: 'Radio Fault: CAD Timeout' },
  { key: 'err_rx_timeout', state: 'off', domain: 'binary_sensor', name: 'Radio Fault: RX-Start Timeout' },
];

function eid(key: string, domain = 'sensor'): string {
  return `${domain}.${NODE}${key}${SUFFIX}`;
}

function makeHass(specs: RawSpec[]): HomeAssistant {
  const states: Record<string, unknown> = {};
  for (const s of specs) {
    states[eid(s.key, s.domain)] = {
      entity_id: eid(s.key, s.domain),
      state: s.state,
      attributes: s.unit ? { unit_of_measurement: s.unit } : {},
      last_updated: new Date().toISOString(),
    };
  }
  return {
    states,
    entities: {},
    callApi: async () => ({}) as never,
    callService: async () => {},
    callWS: async () => ({}) as never,
    connection: { subscribeEvents: async () => () => {} },
  } as unknown as HomeAssistant;
}

// Build the classified EntityInfo[] node-summary consumes, via the real
// classifier (so these tests also cover the classify-entity changes).
function classify(specs: RawSpec[]): EntityInfo[] {
  return specs
    .map((s) => classifyEntity({ entity_id: eid(s.key, s.domain), original_name: s.name }))
    .filter((e): e is EntityInfo => e !== null);
}

function companionDevice(): CompanionDeviceDescriptor {
  return {
    type: 'companion',
    name: 'MattDub',
    pubkey_prefix: '1ed4c1',
    connected: true,
    entry_id: 'test-entry',
  };
}

type Card = HTMLElement & {
  hass?: HomeAssistant;
  device?: CompanionDeviceDescriptor;
  entities?: EntityInfo[];
  updateComplete: Promise<boolean>;
};

async function mount(specs: RawSpec[]): Promise<Card> {
  const el = document.createElement('meshcore-node-summary') as Card;
  el.hass = makeHass(specs);
  el.device = companionDevice();
  el.entities = classify(specs);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

function heroHeads(el: Card): string[] {
  const heads = el.shadowRoot?.querySelectorAll('.hero-tile-head') ?? [];
  return Array.from(heads).map((h) => (h.textContent ?? '').trim());
}

describe('node-summary companion hero — Self Diagnostics ENABLED', () => {
  let el: Card;
  beforeEach(async () => {
    el = await mount([...BASE, ...LOCATION, ...DIAGNOSTICS]);
  });
  afterEach(() => el.remove());

  it('renders the rich repeater-style hero tiles', () => {
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toContain('Battery');
    expect(text).toContain('Last message strength'); // Signal tile
    expect(text).toContain('Radio activity');         // derived from airtime/uptime
    expect(text).toContain('Messages Sent');
    expect(text).toContain('Messages Received');
    expect(text).toContain('Location'); // real coords present -> tile shows
    // Mesh nodes moved to the Settings-tab header; no longer a hero tile.
    expect(text).not.toContain('Mesh nodes');
  });

  it('draws the battery tile exactly once (no double battery)', () => {
    const batteryHeads = heroHeads(el).filter((t) => t.startsWith('Battery'));
    expect(batteryHeads).toHaveLength(1);
  });

  it('derives radio-activity utilisation from airtime ÷ uptime', () => {
    // uptime 0.705 d = 1015.2 min; rx 22.3 min → 2.2%, tx 0.3 min → 0.0%.
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toMatch(/RX 2\.2%/);
    expect(text).toMatch(/TX 0\.0%/);
  });

  it('surfaces recv_errors as a "+N err" legend item and a red error line', () => {
    // recv_errors 638 / (nb_recv 3272 + 638) = 16.3%.
    const errLine = el.shadowRoot?.querySelector('.err-line') as HTMLElement | null;
    expect(errLine).toBeTruthy();
    const title = errLine?.getAttribute('title') ?? '';
    expect(title).toContain('638');
    expect(title).toContain('16.3% of RX');
    // The "+638 err" legend rides on the Received tile's stacked-bar
    // (its own shadow DOM, so read the property rather than textContent).
    const bars = Array.from(
      el.shadowRoot?.querySelectorAll('meshcore-stacked-bar') ?? [],
    ) as Array<{ extraLegendText?: string }>;
    const errBar = bars.find((b) => (b.extraLegendText ?? '').includes('err'));
    expect(errBar?.extraLegendText).toContain('+638 err');
  });

  it('no longer shows the per-tile msg/min rate text', () => {
    const bars = Array.from(
      el.shadowRoot?.querySelectorAll('meshcore-stacked-bar') ?? [],
    ) as Array<{ extraLegendText?: string }>;
    for (const b of bars) {
      expect(b.extraLegendText ?? '').not.toContain('msg/min');
    }
  });

  it('populates the SENSORS table with the remaining diagnostics', () => {
    const table = el.shadowRoot?.querySelector('.sensor-table');
    expect(table).toBeTruthy();
    const tableText = table?.textContent ?? '';
    expect(tableText).toContain('Noise Floor');
    expect(tableText).toContain('TX Queue Length');
  });

  it('renders the radio fault flags as OK / Detected problem rows', () => {
    const table = el.shadowRoot?.querySelector('.sensor-table');
    const tableText = table?.textContent ?? '';
    // The three decoded fault binary_sensors appear as Status rows.
    expect(tableText).toContain('Radio Fault: Packet Pool');
    expect(tableText).toContain('Radio Fault: CAD Timeout');
    expect(tableText).toContain('Radio Fault: RX-Start Timeout');
    // err_pool_full is 'on' -> Detected; the other two 'off' -> OK.
    expect(tableText).toContain('Detected');
    expect(tableText).toContain('OK');
  });
});

describe('node-summary companion hero — Self Diagnostics DISABLED (graceful degradation)', () => {
  let el: Card;
  beforeEach(async () => {
    el = await mount([...BASE]); // diagnostics entities absent
  });
  afterEach(() => el.remove());

  it('falls back to the minimal hero (Power tile only)', () => {
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toContain('USB / mains'); // power tile, no battery entity
    // Mesh nodes moved to the header; Location hidden (no coordinates).
    expect(text).not.toContain('Mesh nodes');
    expect(text).not.toContain('Location');
  });

  it('hides the diagnostic-dependent tiles when their entities are absent', () => {
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).not.toContain('Radio activity');
    expect(text).not.toContain('Last message strength');
    expect(text).not.toContain('Messages Sent');
    expect(text).not.toContain('Messages Received');
  });
});

describe('node-summary companion hero — Location tile visibility', () => {
  it('shows the Location tile when coordinates are present', async () => {
    const el = await mount([...BASE, ...LOCATION, ...DIAGNOSTICS]);
    expect(el.shadowRoot?.textContent ?? '').toContain('Location');
    el.remove();
  });

  it('hides the Location tile for a 0,0 placeholder fix', async () => {
    const el = await mount([...BASE, ...LOCATION_BLANK, ...DIAGNOSTICS]);
    expect(el.shadowRoot?.textContent ?? '').not.toContain('Location');
    el.remove();
  });
});
