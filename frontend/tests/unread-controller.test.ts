import { describe, expect, it, vi } from 'vitest';

import { UnreadController } from '../src/chat/unread-controller';

// ─── Reference implementations ───────────────────────────────────────────
//
// The two pre-refactor badge-lookup implementations, copied verbatim
// from `conversation-list._getUnreadCount` and
// `chat-page._getUnreadCountForSelected` as of commit 59eaaa3. Phase 2
// unifies them into `UnreadController.badgeCount`; these references
// pin the equivalence — `badgeCount` must match both on a shared
// fixture (Risk 2 / Risk 8, proposal §"Verification pass" #8).

function oldConvListGetUnreadCount(
  unreadCounts: Record<string, number>,
  id: string,
  nodePrefix: string | null,
): number {
  const channelNeedle = nodePrefix
    ? `meshcore_${nodePrefix}_ch_${id}_messages`
    : null;
  for (const [entityId, count] of Object.entries(unreadCounts)) {
    if (count <= 0) continue;
    if (/^\d+$/.test(id)) {
      if (channelNeedle) {
        if (entityId.endsWith(channelNeedle)) return count;
      } else if (entityId.endsWith(`_ch_${id}_messages`)) {
        return count;
      }
    } else {
      const prefix6 = id.substring(0, 6);
      if (entityId.endsWith(`_${prefix6}_messages`)) return count;
    }
  }
  return 0;
}

function oldChatPageGetUnreadCountForSelected(
  unreadCounts: Record<string, number>,
  selectedId: string | null,
  currentEntityId: string | null,
  nodePrefix: string | null | undefined,
): number {
  if (!selectedId || !unreadCounts) return 0;
  if (currentEntityId && unreadCounts[currentEntityId]) {
    return unreadCounts[currentEntityId];
  }
  for (const [entityId, count] of Object.entries(unreadCounts)) {
    if (count <= 0) continue;
    if (/^\d+$/.test(selectedId)) {
      if (nodePrefix) {
        if (entityId.endsWith(`meshcore_${nodePrefix}_ch_${selectedId}_messages`))
          return count;
      } else if (entityId.endsWith(`_ch_${selectedId}_messages`)) {
        return count;
      }
    } else {
      const prefix6 = selectedId.substring(0, 6);
      if (entityId.endsWith(`_${prefix6}_messages`)) return count;
    }
  }
  return 0;
}

// Shared fixture exercising: a channel idx that exists on two
// different upstream entries (entry independence), a zero-count
// channel entry, a contact entry, and an unrelated channel.
const FIXTURE: Record<string, number> = {
  'binary_sensor.meshcore_aa1234_ch_1_messages': 3,
  'binary_sensor.meshcore_bb5678_ch_1_messages': 9,
  'binary_sensor.meshcore_aa1234_ch_2_messages': 0,
  'binary_sensor.meshcore_aa1234_deadbe_messages': 5,
  'binary_sensor.meshcore_aa1234_ch_7_messages': 4,
};

function seeded(counts: Record<string, number> = FIXTURE): UnreadController {
  const c = new UnreadController();
  c.ingestBackendData({ unread: { ...counts }, last_read: {} }, null);
  return c;
}

// ─── subscribe plumbing ──────────────────────────────────────────────────

describe('UnreadController — subscribe', () => {
  it('notifies every subscriber on a mutation', () => {
    const c = new UnreadController();
    const a = vi.fn();
    const b = vi.fn();
    c.subscribe(a);
    c.subscribe(b);

    c.ingestBackendData({ unread: { e1: 1 }, last_read: {} }, null);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('the returned unsubscribe fn stops further notifications', () => {
    const c = new UnreadController();
    const cb = vi.fn();
    const unsub = c.subscribe(cb);

    c.ingestBackendData({ unread: { e1: 1 }, last_read: {} }, null);
    expect(cb).toHaveBeenCalledTimes(1);

    unsub();
    c.ingestBackendData({ unread: { e1: 2 }, last_read: {} }, null);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not block the others', () => {
    const c = new UnreadController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    c.subscribe(bad);
    c.subscribe(good);

    c.ingestBackendData({ unread: { e1: 1 }, last_read: {} }, null);

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── counts identity ─────────────────────────────────────────────────────

describe('UnreadController — counts identity', () => {
  it('counts identity changes on ingestBackendData', () => {
    const c = new UnreadController();
    const before = c.counts;
    c.ingestBackendData({ unread: { e1: 1 }, last_read: {} }, null);
    expect(c.counts).not.toBe(before);
  });

  it('counts identity changes on clearEntity (when it mutates)', () => {
    const c = seeded({ 'binary_sensor.meshcore_aa1234_ch_1_messages': 3 });
    const before = c.counts;
    c.clearEntity('binary_sensor.meshcore_aa1234_ch_1_messages');
    expect(c.counts).not.toBe(before);
  });

  it('counts identity is stable between mutations', () => {
    const c = seeded();
    const a = c.counts;
    const b = c.counts;
    expect(a).toBe(b);
  });

  it('clearEntity is a no-op (no identity change, no notify) for an absent / zero entity', () => {
    const c = seeded({ 'binary_sensor.meshcore_aa1234_ch_1_messages': 0 });
    const cb = vi.fn();
    c.subscribe(cb);
    const before = c.counts;

    c.clearEntity('binary_sensor.meshcore_aa1234_ch_1_messages'); // zero count
    c.clearEntity('binary_sensor.meshcore_does_not_exist_messages'); // absent

    expect(c.counts).toBe(before);
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── ingestBackendData ───────────────────────────────────────────────────

describe('UnreadController — ingestBackendData', () => {
  it('zeroes the active entity', () => {
    const c = new UnreadController();
    c.ingestBackendData(
      {
        unread: {
          'binary_sensor.meshcore_aa1234_ch_1_messages': 7,
          'binary_sensor.meshcore_aa1234_ch_2_messages': 2,
        },
        last_read: {},
      },
      'binary_sensor.meshcore_aa1234_ch_1_messages',
    );
    expect(c.counts['binary_sensor.meshcore_aa1234_ch_1_messages']).toBe(0);
    expect(c.counts['binary_sensor.meshcore_aa1234_ch_2_messages']).toBe(2);
  });

  it('leaves counts untouched when the active entity is null or absent', () => {
    const c = new UnreadController();
    c.ingestBackendData(
      { unread: { 'binary_sensor.meshcore_aa1234_ch_1_messages': 7 }, last_read: {} },
      null,
    );
    expect(c.counts['binary_sensor.meshcore_aa1234_ch_1_messages']).toBe(7);

    c.ingestBackendData(
      { unread: { 'binary_sensor.meshcore_aa1234_ch_1_messages': 7 }, last_read: {} },
      'binary_sensor.meshcore_not_in_map_messages',
    );
    expect(c.counts['binary_sensor.meshcore_aa1234_ch_1_messages']).toBe(7);
  });

  it('does not retain a reference to the caller-supplied payload maps', () => {
    const c = new UnreadController();
    const unread = { e1: 1 };
    const last_read = { e1: 'msg-1' };
    c.ingestBackendData({ unread, last_read }, null);
    unread.e1 = 999;
    last_read.e1 = 'mutated';
    expect(c.counts.e1).toBe(1);
    expect(c.lastRead.e1).toBe('msg-1');
  });

  it('exposes last_read via the lastRead getter', () => {
    const c = new UnreadController();
    c.ingestBackendData(
      { unread: {}, last_read: { e1: 'msg-anchor' } },
      null,
    );
    expect(c.lastRead).toEqual({ e1: 'msg-anchor' });
  });
});

// ─── badgeCount equivalence ──────────────────────────────────────────────

describe('UnreadController — badgeCount matches the two pre-refactor impls', () => {
  const cases: Array<{
    name: string;
    id: string;
    nodePrefix: string | null;
    directKey?: string | null;
  }> = [
    { name: 'channel, nodePrefix scoped (entry aa)', id: '1', nodePrefix: 'aa1234' },
    { name: 'channel, nodePrefix scoped (entry bb — entry independence)', id: '1', nodePrefix: 'bb5678' },
    { name: 'channel, no nodePrefix (suffix-only fallback)', id: '1', nodePrefix: null },
    { name: 'channel, unrelated idx', id: '7', nodePrefix: 'aa1234' },
    { name: 'channel, zero-count entry', id: '2', nodePrefix: 'aa1234' },
    { name: 'channel, no match', id: '99', nodePrefix: 'aa1234' },
    { name: 'contact by pubkey prefix', id: 'deadbeef0011', nodePrefix: 'aa1234' },
    { name: 'contact, no match', id: 'ffffffff0000', nodePrefix: 'aa1234' },
  ];

  for (const tc of cases) {
    it(`conversation-list parity — ${tc.name}`, () => {
      const c = seeded();
      expect(c.badgeCount(tc.id, tc.nodePrefix)).toBe(
        oldConvListGetUnreadCount(FIXTURE, tc.id, tc.nodePrefix),
      );
    });

    it(`chat-page parity — ${tc.name}`, () => {
      const c = seeded();
      expect(c.badgeCount(tc.id, tc.nodePrefix, null)).toBe(
        oldChatPageGetUnreadCountForSelected(FIXTURE, tc.id, null, tc.nodePrefix),
      );
    });
  }

  it('chat-page parity — direct-key fast path hit', () => {
    const c = seeded();
    const directKey = 'binary_sensor.meshcore_aa1234_ch_1_messages';
    expect(c.badgeCount('1', 'aa1234', directKey)).toBe(
      oldChatPageGetUnreadCountForSelected(FIXTURE, '1', directKey, 'aa1234'),
    );
    expect(c.badgeCount('1', 'aa1234', directKey)).toBe(3);
  });

  it('chat-page parity — direct-key present but zero falls through to the pattern loop', () => {
    const c = seeded();
    const directKey = 'binary_sensor.meshcore_aa1234_ch_2_messages'; // count 0 in FIXTURE
    expect(c.badgeCount('2', 'aa1234', directKey)).toBe(
      oldChatPageGetUnreadCountForSelected(FIXTURE, '2', directKey, 'aa1234'),
    );
    expect(c.badgeCount('2', 'aa1234', directKey)).toBe(0);
  });

  it('returns 0 for a null / empty conversation id', () => {
    const c = seeded();
    expect(c.badgeCount(null, 'aa1234')).toBe(0);
    expect(c.badgeCount('', 'aa1234')).toBe(0);
  });
});

// ─── mark-read-requested plumbing ────────────────────────────────────────

describe('UnreadController — mark-read-requested plumbing', () => {
  it('requestMarkRead forwards to the registered handler', () => {
    const c = new UnreadController();
    const handler = vi.fn();
    c.onMarkReadRequested(handler);
    c.requestMarkRead('binary_sensor.meshcore_aa1234_ch_1_messages');
    expect(handler).toHaveBeenCalledWith('binary_sensor.meshcore_aa1234_ch_1_messages');
  });

  it('requestMarkRead is a safe no-op when no handler is registered', () => {
    const c = new UnreadController();
    expect(() => c.requestMarkRead('e1')).not.toThrow();
  });
});
