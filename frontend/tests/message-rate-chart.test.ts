// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import '../src/components/message-rate-chart';
import type { RatePoint } from '../src/components/message-rate-chart';

type Chart = HTMLElement & { data?: RatePoint[]; updateComplete: Promise<boolean> };

async function mount(data: RatePoint[]): Promise<Chart> {
  const el = document.createElement('meshcore-message-rate-chart') as Chart;
  el.data = data;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('message-rate-chart', () => {
  let el: Chart | undefined;
  afterEach(() => el?.remove());

  it('renders nothing when there is no data', async () => {
    el = await mount([]);
    expect(el.shadowRoot?.querySelector('svg')).toBeNull();
    expect(el.shadowRoot?.querySelector('.chart-container')).toBeNull();
  });

  it('draws an svg + the three-series legend when given data', async () => {
    const now = Date.now();
    el = await mount([
      { timestamp: now - 3_600_000, values: { sent: 1.2, recv: 3.4, errors: 0.1 } },
      { timestamp: now, values: { sent: 0.8, recv: 2.1, errors: 0 } },
    ]);
    expect(el.shadowRoot?.querySelector('svg')).toBeTruthy();
    const text = el.shadowRoot?.textContent ?? '';
    expect(text).toContain('Sent');
    expect(text).toContain('Received');
    expect(text).toContain('Errors');
    expect(text).toContain('msg/min');
    const polylines = el.shadowRoot?.querySelectorAll('polyline') ?? [];
    expect(polylines.length).toBeGreaterThanOrEqual(2);
  });

  it('renders a single datapoint as a dot rather than a line', async () => {
    el = await mount([{ timestamp: Date.now(), values: { sent: 5, recv: 0, errors: 0 } }]);
    expect(el.shadowRoot?.querySelector('circle')).toBeTruthy();
  });
});
