"""Config flow for MeshCore Chat.

Two preconditions are enforced before an entry is created:
  1. The upstream `meshcore` integration must be installed (matches the
     hard-gate `dependencies: ["meshcore"]` in manifest.json — without
     this in-flow check, the flow would succeed and setup would then
     fail with a runtime ImportError surfaced as a generic error).
  2. Only a single instance of `meshcore_chat` may exist.
"""
from __future__ import annotations

from typing import Any

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResult
from homeassistant.loader import IntegrationNotFound, async_get_integration

DOMAIN = "meshcore_chat"


class MeshCoreChatConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a MeshCore Chat config flow."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Single-step flow: gate on meshcore + singleton, then create entry."""
        # Hard gate: refuse to create the entry if the upstream meshcore
        # integration isn't installed. async_get_integration is the
        # canonical "is integration X available" probe — it raises
        # IntegrationNotFound without forcing a load.
        try:
            await async_get_integration(self.hass, "meshcore")
        except IntegrationNotFound:
            return self.async_abort(reason="meshcore_not_installed")

        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        return self.async_create_entry(title="MeshCore Chat", data={})
