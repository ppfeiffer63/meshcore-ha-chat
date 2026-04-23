"""MeshCore Chat companion integration for Home Assistant.

This branch (`feature/frontend-lift-sidebar-panel`) adds the sidebar
panel registration to the Phase 1 scaffold. The backend (message store,
WS API, event listeners) lives on the sibling branch
`feature/backend-lift-message-store`; once both feature branches merge
to `main` for the v0.1 cut, `async_setup_entry` will instantiate both
the message store / event subscriptions AND register the panel.
"""
from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .panel import async_register_panel, async_remove_panel

DOMAIN = "meshcore_chat"

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up MeshCore Chat from a config entry."""
    bucket = hass.data.setdefault(DOMAIN, {})
    bucket[entry.entry_id] = {}

    # Register the sidebar panel exactly once per HA process. The panel
    # is process-global (not per-entry) — the config-flow is single-
    # instance, so in practice this is also one-per-config-entry, but
    # the guard protects against accidental re-registration if that
    # invariant ever changes.
    if not bucket.get("_panel_registered"):
        await async_register_panel(hass)
        bucket["_panel_registered"] = True
        _LOGGER.debug("MeshCore Chat panel registered")

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down a config entry."""
    bucket = hass.data.get(DOMAIN, {})
    bucket.pop(entry.entry_id, None)

    # If this was the last config entry, drop the panel too. The bucket
    # always contains the per-entry sub-dicts plus the `_panel_registered`
    # flag; once we've popped this entry, anything else in the bucket
    # that *isn't* the flag means another entry is still live.
    remaining = [k for k in bucket if k != "_panel_registered"]
    if not remaining and bucket.get("_panel_registered"):
        await async_remove_panel(hass)
        bucket.pop("_panel_registered", None)
        _LOGGER.debug("MeshCore Chat panel removed (last entry unloaded)")

    return True
