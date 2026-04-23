"""MeshCore Chat companion integration for Home Assistant.

Phase 1 scaffold. The backend (message store, WS API, event listeners) lands
in Phase 2; the frontend panel lands in Phase 3.
"""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

DOMAIN = "meshcore_chat"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up MeshCore Chat from a config entry. Phase 1 placeholder."""
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {}
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Tear down a config entry. Phase 1 placeholder."""
    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return True
