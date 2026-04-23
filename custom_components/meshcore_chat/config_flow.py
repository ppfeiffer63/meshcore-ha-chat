"""Config flow for MeshCore Chat.

Phase 1: single-instance enforcement only. Phase 2 adds the soft gate that
warns when the core meshcore integration is not loaded.
"""
from __future__ import annotations

from typing import Any

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult

DOMAIN = "meshcore_chat"


class MeshCoreChatConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a MeshCore Chat config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Single-step flow: enforce singleton, then create entry."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        return self.async_create_entry(title="MeshCore Chat", data={})
