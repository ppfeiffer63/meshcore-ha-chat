/**
 * Backend payload shape for `meshcore_chat/get_unread_counts`. Phase 1
 * of the Cursor-Derived proposal extended the response from a bare
 * `unread` map to `{ unread, last_read }`; `getUnreadAndLastRead` in
 * `api.ts` returns exactly this shape.
 */
export interface UnreadBackendData {
  unread: Record<string, number>;
  last_read: Record<string, string>;
}

/**
 * UnreadController — the single panel-owned source of truth for the
 * frontend's "unread" state.
 *
 * Phase 2 surface (this file): the backend-data side and the badge
 * projection only — `subscribe` / `onMarkReadRequested` plumbing, the
 * `ingestBackendData` / `clearEntity` mutators, the `counts` /
 * `lastRead` getters, and the `badgeCount` projection that unifies the
 * two pre-refactor badge-lookup implementations
 * (`conversation-list._getUnreadCount` and
 * `chat-page._getUnreadCountForSelected`).
 *
 * The per-conversation read-progress machine (anchor, grace window,
 * deferred timer, mark-read dedup) and `cursorAtTail` are NOT here yet
 * — they migrate in Phases 3 and 4. See
 * `docs/Proposed - Unify Unread State (Frontend).md`.
 *
 * Lifetime: constructed once by `meshcore-chat-panel.ts` and owned by
 * the panel. The panel is not remounted on tab switch, so the badge
 * map and the `meshcore_unread_updated` subscription state persist
 * correctly. `<chat-page>` (which IS remounted on tab switch)
 * `subscribe`s in `connectedCallback` and unsubscribes — but does NOT
 * destroy — in `disconnectedCallback`.
 */
export class UnreadController {
  /**
   * Authoritative per-entity unread counts, keyed by entity_id. Every
   * mutator assigns a FRESH object here, so the `counts` getter's
   * identity changes on every mutation and is stable between
   * mutations — exactly what Lit's `.prop=` identity check needs.
   * `<conversation-list>` is bound via `.unreadCounts=${unread.counts}`
   * and relies on that identity change to re-render.
   */
  private _counts: Record<string, number> = {};

  /** Authoritative per-entity last-read message-ID cursor map. */
  private _lastRead: Record<string, string> = {};

  /**
   * Re-render subscribers. Multi-subscriber by design: the controller
   * is panel-owned but its primary consumer (`<chat-page>`) has a
   * decoupled mount lifecycle, and a single-callback model would
   * silently break the day a second consumer is added.
   */
  private _subscribers = new Set<() => void>();

  /**
   * Handler the panel registers to own the mark-read WS round-trip +
   * unread bookkeeping. Phase 2 wires the registration plumbing; the
   * emitter (the read-progress mutators that call `requestMarkRead`)
   * lands in Phase 3, so in Phase 2 this is registered-but-unfired.
   */
  private _markReadRequestedHandler: ((entityId: string) => void) | null = null;

  // ---- subscriber plumbing ----------------------------------------------

  /**
   * Register a re-render callback. Returns an unsubscribe function.
   */
  subscribe(cb: () => void): () => void {
    this._subscribers.add(cb);
    return () => {
      this._subscribers.delete(cb);
    };
  }

  /**
   * Register the panel's mark-read-requested handler — the panel owns
   * the WS round-trip and the unread bookkeeping. Only one handler is
   * supported (the panel is the sole owner).
   */
  onMarkReadRequested(cb: (entityId: string) => void): void {
    this._markReadRequestedHandler = cb;
  }

  /**
   * Emit a mark-read request to the panel-registered handler. The
   * Phase 3 read-progress mutators call this; in Phase 2 it exists
   * only to complete the registration plumbing (no caller yet).
   */
  requestMarkRead(entityId: string): void {
    if (entityId && this._markReadRequestedHandler) {
      this._markReadRequestedHandler(entityId);
    }
  }

  private _notify(): void {
    // Iterate a copy so an unsubscribe during notification is safe.
    for (const cb of [...this._subscribers]) {
      try {
        cb();
      } catch (err) {
        console.error('[UnreadController] subscriber callback threw', err);
      }
    }
  }

  // ---- authoritative state ----------------------------------------------

  /**
   * Replace the unread + last-read maps from a fresh backend payload.
   * Zeroes the actively-viewed conversation's count (the user is
   * already reading it) — this folds in the zeroing the panel's
   * `_loadUnreadCounts` did inline before the controller existed.
   */
  ingestBackendData(payload: UnreadBackendData, activeEntityId: string | null): void {
    const counts: Record<string, number> = { ...(payload?.unread ?? {}) };
    if (activeEntityId && counts[activeEntityId]) {
      counts[activeEntityId] = 0;
    }
    this._counts = counts;
    this._lastRead = { ...(payload?.last_read ?? {}) };
    this._notify();
  }

  /**
   * Optimistically zero a single entity's count without waiting for a
   * backend round-trip. Used by the panel's `_onUnreadCleared` (the
   * `unread-cleared` bubble from chat-page's `_markActiveRead`); the
   * panel still issues an authoritative `_loadUnreadCounts` refresh
   * right after — this just removes the visible lag.
   *
   * No-op (no notify) when the entity has no positive count, matching
   * the pre-refactor guard in the panel.
   */
  clearEntity(entityId: string): void {
    if (entityId && this._counts[entityId]) {
      this._counts = { ...this._counts, [entityId]: 0 };
      this._notify();
    }
  }

  /**
   * Fresh-identity snapshot of the unread counts, keyed by entity_id.
   * Identity changes on every mutation and is stable between
   * mutations — see `_counts`.
   */
  get counts(): Record<string, number> {
    return this._counts;
  }

  /** Per-entity last-read message-ID cursor map. */
  get lastRead(): Record<string, string> {
    return this._lastRead;
  }

  // ---- projections ------------------------------------------------------

  /**
   * Unified badge-count lookup — one implementation replacing both
   * `conversation-list._getUnreadCount` and
   * `chat-page._getUnreadCountForSelected`.
   *
   * @param idOrSelectedId  Conversation id: a numeric string for a
   *   channel (e.g. "1"), or a hex pubkey prefix for a contact.
   * @param nodePrefix  The entry's 6-char pubkey prefix, used to scope
   *   channel matches so same-named channels on different upstream
   *   entries don't cross-contaminate (Phase 4 F-B). `null` on
   *   single-entry installs / before config arrives → suffix-only
   *   match, as before.
   * @param directKey  Optional resolved entity_id for a direct-key
   *   fast path. `chat-page._getUnreadCountForSelected` had this
   *   (`_currentEntityId`); `conversation-list._getUnreadCount` did
   *   not — callers that lack it pass nothing.
   */
  badgeCount(
    idOrSelectedId: string | null,
    nodePrefix: string | null,
    directKey?: string | null,
  ): number {
    if (!idOrSelectedId) return 0;
    const counts = this._counts;

    // Direct match on a resolved entity_id (most reliable). Folds in
    // `_getUnreadCountForSelected`'s fast path; the `> 0` truthy check
    // matches the pre-refactor behavior (a 0 count falls through to
    // the pattern loop, which also skips it).
    if (directKey && counts[directKey]) {
      return counts[directKey];
    }

    const isChannel = /^\d+$/.test(idOrSelectedId);
    const channelNeedle = nodePrefix
      ? `meshcore_${nodePrefix}_ch_${idOrSelectedId}_messages`
      : null;

    for (const [entityId, count] of Object.entries(counts)) {
      if (count <= 0) continue;
      if (isChannel) {
        // Channel: numeric id → match `_ch_{id}_messages`, scoped by
        // nodePrefix when known.
        if (channelNeedle) {
          if (entityId.endsWith(channelNeedle)) return count;
        } else if (entityId.endsWith(`_ch_${idOrSelectedId}_messages`)) {
          return count;
        }
      } else {
        // Contact: hex pubkey prefix → match `_{first6}_messages`.
        // Contact prefixes are globally unique across entries, so no
        // nodePrefix scoping is needed.
        const prefix6 = idOrSelectedId.substring(0, 6);
        if (entityId.endsWith(`_${prefix6}_messages`)) return count;
      }
    }
    return 0;
  }
}
