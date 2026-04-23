"""MeshCore Chat companion integration for Home Assistant.

Two responsibilities at runtime:

  1. Per-entry message-store backend. Subscribes to events fired by the
     upstream ``meshcore`` integration (``meshcore_message``,
     ``meshcore_delivery_update``, ``meshcore_connected``,
     ``meshcore_disconnected``) and persists each chat message to a
     per-conversation store. Exposes the ``meshcore_chat/*`` WebSocket
     command namespace and an UnreadTracker singleton.

  2. Process-global sidebar panel registration. The Lit/TypeScript
     panel (under ``frontend/``) is served from this integration and
     registered once per HA process; entries beyond the first re-use
     the existing registration. The panel reads message history through
     the WS commands above and *sends* new messages via the upstream
     ``meshcore.send_*`` services — never via this integration.

The hard manifest dependency on ``meshcore`` (since 4e65769) plus the
config-flow abort (since 594c9aa) guarantee the upstream integration is
present whenever ``async_setup_entry`` runs here.
"""
from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback

from .const import (
    DOMAIN,
    EVENT_MESHCORE_CONNECTED,
    EVENT_MESHCORE_DELIVERY_UPDATE,
    EVENT_MESHCORE_DISCONNECTED,
    EVENT_MESHCORE_MESSAGE,
)
from .message_store import MessageStore
from .panel import async_register_panel, async_remove_panel
from .unread_tracking import UnreadTracker
from .ws_api import async_register_ws_commands

_LOGGER = logging.getLogger(__name__)

# Per-instance bucket key holding the unsubscribe callbacks for the four
# event listeners we register. Cleared in async_unload_entry.
_LISTENERS_KEY = "listeners"

# Domain-bucket flag keys (as opposed to per-entry sub-dicts). Used by
# async_unload_entry to distinguish "another entry is still around" from
# "only flags remain — safe to tear down process-global state".
_DOMAIN_FLAGS = frozenset(
    {"_panel_registered", "_ws_registered", "unread_tracker"}
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up MeshCore Chat from a config entry."""
    bucket = hass.data.setdefault(DOMAIN, {})
    entry_bucket: dict[str, Any] = {}
    bucket[entry.entry_id] = entry_bucket

    # Process-global: register the sidebar panel exactly once. The panel
    # is not per-entry — the config-flow is single-instance, so in practice
    # this is also one-per-config-entry, but the guard protects against
    # accidental re-registration if that invariant ever changes.
    if not bucket.get("_panel_registered"):
        await async_register_panel(hass)
        bucket["_panel_registered"] = True
        _LOGGER.debug("MeshCore Chat panel registered")

    # Initialize the per-entry message store and load its lightweight index.
    store = MessageStore(hass, entry)
    await store.async_load_index()
    entry_bucket["store"] = store

    # Best-effort retention pass at startup. Failures here must not block
    # setup — they are logged and we continue.
    try:
        await store.cleanup_old_messages()
    except Exception as ex:  # pragma: no cover - defensive
        _LOGGER.warning(
            "MessageStore retention cleanup failed at startup: %s", ex
        )

    # Unread tracker is a process-wide singleton (not per-entry) — the
    # frontend identifies conversations by entity_id, which is globally
    # unique across config entries. Stash it on the domain bucket where the
    # WS handlers expect to find it (hass.data[DOMAIN]["unread_tracker"]).
    if "unread_tracker" not in bucket:
        bucket["unread_tracker"] = UnreadTracker(hass)

    # Register WS commands once (idempotent registration would be ideal but
    # HA's websocket_api raises on duplicate types — guard with a flag on the
    # domain bucket so multiple config entries don't collide).
    if not bucket.get("_ws_registered"):
        async_register_ws_commands(hass)
        bucket["_ws_registered"] = True

    # Subscribe to upstream meshcore events.
    entry_bucket[_LISTENERS_KEY] = [
        hass.bus.async_listen(
            EVENT_MESHCORE_MESSAGE,
            _make_message_handler(hass, entry.entry_id),
        ),
        hass.bus.async_listen(
            EVENT_MESHCORE_DELIVERY_UPDATE,
            _make_delivery_update_handler(hass, entry.entry_id),
        ),
        hass.bus.async_listen(
            EVENT_MESHCORE_CONNECTED,
            _make_connection_state_handler(hass, entry.entry_id, connected=True),
        ),
        hass.bus.async_listen(
            EVENT_MESHCORE_DISCONNECTED,
            _make_connection_state_handler(hass, entry.entry_id, connected=False),
        ),
    ]

    _LOGGER.info(
        "MeshCore Chat configured for entry %s (%d conversations indexed)",
        entry.entry_id,
        len(store.get_message_index()),
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down a config entry."""
    bucket = hass.data.get(DOMAIN, {})
    entry_bucket = bucket.pop(entry.entry_id, None)
    if not entry_bucket:
        return True

    # Per-entry teardown: unsubscribe event listeners and unload the store.
    for unsub in entry_bucket.get(_LISTENERS_KEY, []):
        try:
            unsub()
        except Exception:  # pragma: no cover - defensive
            pass

    store: MessageStore | None = entry_bucket.get("store")
    if store is not None:
        await store.async_unload()

    # If this was the last config entry, drop the process-global state
    # too (panel registration, WS commands, UnreadTracker). After popping
    # this entry, anything left in the bucket that *isn't* a known flag
    # means another entry is still live.
    remaining = [k for k in bucket if k not in _DOMAIN_FLAGS]
    if not remaining:
        if bucket.get("_panel_registered"):
            await async_remove_panel(hass)
            bucket.pop("_panel_registered", None)
            _LOGGER.debug("MeshCore Chat panel removed (last entry unloaded)")
        # WS commands and UnreadTracker live for the lifetime of the HA
        # process — there's no public unregister API for either, and re-
        # registering after a re-add of the integration is guarded above.
        # We deliberately leave _ws_registered and unread_tracker in
        # place so a subsequent async_setup_entry doesn't try to re-register.

    return True


# ─── event handlers ─────────────────────────────────────────────────────


def _store_message_id(payload: dict) -> str | None:
    """Best-effort extraction of a stable message id from the event payload.

    Upstream events use the ``id`` field once a message has been written
    via the SDK helper; older paths use ``send_id`` (outgoing) or rely on
    the receiver computing the deterministic SHA-256 id (timestamp|sender|text).
    We accept either explicit field if present; we deliberately do NOT
    recompute the deterministic id here because it requires the upstream
    helper and we want to avoid duplicating that surface in the companion.
    """
    msg_id = payload.get("id") or payload.get("message_id") or payload.get("send_id")
    return str(msg_id) if msg_id else None


def _make_message_handler(hass: HomeAssistant, entry_id: str):
    """Return a listener that persists incoming/outgoing meshcore_message events."""

    async def _handle(event: Event) -> None:
        store = _resolve_store(hass, entry_id)
        if store is None:
            return

        data = event.data or {}
        entity_id = data.get("entity_id")
        if not entity_id:
            # Without an entity_id we don't know which conversation to write
            # to. The upstream meshcore integration always sets this; bail
            # quietly rather than scanning.
            return

        msg_id = _store_message_id(data)
        if not msg_id:
            # Fall back to a synthetic id from the event tuple. The store
            # dedups by id within the recent window, so identical tuples
            # won't double-store.
            msg_id = (
                f"{data.get('timestamp', '')}|"
                f"{data.get('sender_name', '')}|"
                f"{(data.get('message') or '')[:64]}"
            )

        # Build the stored record from whatever fields the event carries.
        # Per Adaptation 4 in the proposal, missing fields like hop_count
        # and snr are simply not present in the dict.
        record: dict[str, Any] = {
            "id": msg_id,
            "sender": data.get("sender_name") or data.get("sender") or "",
            "text": data.get("message") or data.get("text") or "",
            "timestamp": data.get("timestamp", ""),
            "message_type": data.get("message_type", ""),
            "outgoing": bool(data.get("outgoing", False)),
        }
        # Optional metadata — copy through only if present.
        for k in (
            "channel",
            "channel_idx",
            "pubkey_prefix",
            "receiver_name",
            "rx_log_data",
            "repeater_count",
            "hop_count",
            "snr",
            "ack_received",
            "send_id",
            "delivery_status",
        ):
            if k in data:
                record[k] = data[k]

        # Default delivery_status: "sent" for inbound, "pending" for outbound
        # without an explicit ack signal. Don't override if the upstream
        # event already set one.
        record.setdefault(
            "delivery_status",
            "sent" if not record["outgoing"] else "pending",
        )

        await store.store_message(entity_id, record)

        # Inbound (non-outgoing) messages increment the unread count for
        # this conversation. Frontend listens on EVENT_UNREAD_UPDATED and
        # updates the per-conversation badge; the panel calls
        # meshcore_chat/mark_conversation_read to clear it on read.
        if not record["outgoing"]:
            tracker = hass.data.get(DOMAIN, {}).get("unread_tracker")
            if tracker is not None:
                await tracker.mark_unread(entity_id)

    return _handle


def _make_delivery_update_handler(hass: HomeAssistant, entry_id: str):
    """Return a listener that applies meshcore_delivery_update to a stored message.

    Per Adaptation 5 in the proposal: if ``entity_id`` is missing on the
    event (pre-PR-B), fall back to an all-conversations scan to locate the
    message by id.
    """

    async def _handle(event: Event) -> None:
        store = _resolve_store(hass, entry_id)
        if store is None:
            return

        data = event.data or {}
        msg_id = _store_message_id(data)
        if not msg_id:
            return

        status = data.get("delivery_status") or (
            "sent" if data.get("ack_received") else "pending"
        )
        kwargs: dict[str, Any] = {}
        for k in ("rx_log_data", "repeater_count", "ack_received"):
            if k in data:
                kwargs[k] = data[k]

        entity_id = data.get("entity_id")
        if entity_id:
            await store.update_message_delivery(
                entity_id, msg_id, status, **kwargs
            )
            # Some delivery updates carry the final rx_log_data — keep both
            # the rx_log mirror and the delivery row in sync.
            if "rx_log_data" in kwargs:
                await store.update_message_rx_data(
                    entity_id, msg_id, kwargs["rx_log_data"]
                )
        else:
            # Pre-PR-B: scan all conversations.
            located = await store.update_message_delivery_any(
                msg_id, status, **kwargs
            )
            if located and "rx_log_data" in kwargs:
                await store.update_message_rx_data(
                    located, msg_id, kwargs["rx_log_data"]
                )

    return _handle


def _make_connection_state_handler(
    hass: HomeAssistant, entry_id: str, *, connected: bool
):
    """Return a listener for meshcore_connected / meshcore_disconnected.

    The store does not currently persist node connection state — the panel
    surfaces it from binary_sensor entity state. This handler is a hook
    point for future use (e.g. inserting system messages into a
    conversation timeline). For now it is a no-op stub that exists so the
    subscription is in place and any future behavior change does not
    require an integration restart.
    """

    @callback
    def _handle(event: Event) -> None:
        _LOGGER.debug(
            "meshcore_%sconnected received (entry %s); no action taken",
            "" if connected else "dis",
            entry_id,
        )

    return _handle


def _resolve_store(hass: HomeAssistant, entry_id: str) -> MessageStore | None:
    """Look up the MessageStore for an entry, defensively."""
    bucket = hass.data.get(DOMAIN, {}).get(entry_id)
    if not bucket:
        return None
    store = bucket.get("store")
    return store if isinstance(store, MessageStore) else None
