"""WebSocket API handlers for MeshCore Chat.

All commands are namespaced under ``meshcore_chat/*`` to keep the
companion's surface distinct from the upstream ``meshcore.*`` integration.
The frontend talks to *these* handlers for stored-message reads;
*sends* (``meshcore.send_message``, ``meshcore.send_channel_message``,
etc.) remain on the upstream integration and are not implemented here.

Lookup contract: ``hass.data["meshcore_chat"][entry_id]["store"]`` holds
the per-entry :class:`MessageStore` instance. If no ``entry_id`` is given,
the first registered entry's store is used.
"""
from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .message_store import MessageStore

_LOGGER = logging.getLogger(__name__)


def _get_store(
    hass: HomeAssistant, entry_id: str | None = None
) -> MessageStore | None:
    """Return the MessageStore for ``entry_id`` (or the first one).

    Returns None if the integration isn't loaded or the entry has no store.
    """
    bucket = hass.data.get(DOMAIN)
    if not bucket:
        return None

    if entry_id and entry_id in bucket:
        store = bucket[entry_id].get("store")
        return store if isinstance(store, MessageStore) else None

    # Fallback: first available entry with a store.
    for value in bucket.values():
        store = value.get("store") if isinstance(value, dict) else None
        if isinstance(store, MessageStore):
            return store
    return None


def async_register_ws_commands(hass: HomeAssistant) -> None:
    """Register all MeshCore Chat WebSocket commands."""
    websocket_api.async_register_command(hass, ws_get_stored_messages)
    websocket_api.async_register_command(hass, ws_get_stored_message_count)
    websocket_api.async_register_command(hass, ws_search_stored_messages)


# ─── meshcore_chat/get_stored_messages ────────────────────────────────────


@websocket_api.websocket_command(
    {
        vol.Required("type"): "meshcore_chat/get_stored_messages",
        vol.Required("entity_id"): str,
        vol.Optional("limit", default=50): int,
        vol.Optional("before"): str,
        vol.Optional("after"): str,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_get_stored_messages(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Get stored messages for a conversation with cursor pagination."""
    store = _get_store(hass, msg.get("entry_id"))
    if store is None:
        connection.send_error(
            msg["id"], "not_found", "No MeshCore Chat message store found"
        )
        return

    limit = msg.get("limit", 50)
    messages = await store.get_messages(
        msg["entity_id"],
        limit=limit,
        before=msg.get("before"),
        after=msg.get("after"),
    )
    connection.send_result(
        msg["id"],
        {"messages": messages, "has_more": len(messages) == limit},
    )


# ─── meshcore_chat/get_stored_message_count ──────────────────────────────


@websocket_api.websocket_command(
    {
        vol.Required("type"): "meshcore_chat/get_stored_message_count",
        vol.Required("entity_id"): str,
        vol.Optional("entry_id"): str,
    }
)
@callback
def ws_get_stored_message_count(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Get message count for a conversation from the in-memory index."""
    store = _get_store(hass, msg.get("entry_id"))
    if store is None:
        connection.send_error(
            msg["id"], "not_found", "No MeshCore Chat message store found"
        )
        return

    index_entry = store.get_message_index().get(msg["entity_id"], {})
    connection.send_result(
        msg["id"], {"count": index_entry.get("message_count", 0)}
    )


# ─── meshcore_chat/search_stored_messages ────────────────────────────────


@websocket_api.websocket_command(
    {
        vol.Required("type"): "meshcore_chat/search_stored_messages",
        vol.Required("query"): str,
        vol.Optional("entity_id"): str,
        vol.Optional("from_date"): str,
        vol.Optional("to_date"): str,
        vol.Optional("limit", default=20): int,
        vol.Optional("entry_id"): str,
    }
)
@websocket_api.async_response
async def ws_search_stored_messages(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    """Search stored messages by text or sender name.

    The store performs the actual scan via non-caching reads. We resolve
    each result's ``conversation_name`` against HA entity state here so
    the store stays free of state lookups.
    """
    store = _get_store(hass, msg.get("entry_id"))
    if store is None:
        connection.send_error(
            msg["id"], "not_found", "No MeshCore Chat message store found"
        )
        return

    raw_results = await store.search(
        msg["query"],
        entity_id=msg.get("entity_id"),
        from_date=msg.get("from_date"),
        to_date=msg.get("to_date"),
        limit=msg.get("limit", 20),
    )

    enriched: list[dict] = []
    for r in raw_results:
        eid = r.get("entity_id", "")
        state = hass.states.get(eid) if eid else None
        conv_name = (
            state.attributes.get("friendly_name", eid) if state else eid
        )
        enriched.append({**r, "conversation_name": conv_name})

    connection.send_result(msg["id"], {"results": enriched})
