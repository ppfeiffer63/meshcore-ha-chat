# MeshCore Chat for Home Assistant

A sidebar chat panel and persistent message store for the [MeshCore](https://meshcore.io) mesh radio network.

Works as a **companion** to the [core meshcore integration](https://github.com/meshcore-dev/meshcore-ha) — install both. This integration does not drive the radio itself; it adds a chat UI, message persistence, and search on top of the events and services exposed by the core integration.

> **Status:** v0.1 in active development. README will be expanded with screenshots and a feature tour at the v0.1.0 tag.

## Features (v0.1)

- Sidebar chat panel with channels, DMs, and contact list
- Persistent message history (survives Home Assistant restarts)
- Trace / path-discovery dialog with route visualization
- Per-conversation search
- Unread counts, delivery status

## Installation

### HACS (custom repository)

1. In HACS → Integrations → ⋮ → Custom repositories
2. Add `https://github.com/mwolter805/meshcore-ha-chat` as an "Integration"
3. Install **MeshCore Chat**
4. Restart Home Assistant
5. Settings → Devices & Services → Add Integration → **MeshCore Chat**

### Manual

Copy `custom_components/meshcore_chat/` into your HA `config/custom_components/` directory. Restart HA. Add the integration from the UI.

## Requirements

- Home Assistant 2024.12 or newer
- The core [meshcore integration](https://github.com/meshcore-dev/meshcore-ha) installed and configured

## Relationship to other projects

- [meshcore-dev/meshcore-ha](https://github.com/meshcore-dev/meshcore-ha) — the core integration that drives the MeshCore radio. **Required.**
- [Ratty7198/MeshCore-HA-UI](https://github.com/Ratty7198/MeshCore-HA-UI) — an alternative companion UI. Great work; this project differs by using a typed/compiled Lit frontend and adding per-conversation persistence, search, and a trace dialog. The two projects use distinct domains, panel URLs, and webcomponent tags so they can coexist on the same HA instance, but installing both produces two sidebar entries — pick one.

## Development

The frontend is TypeScript built via Rollup. To rebuild after editing source:

```
cd custom_components/meshcore_chat/frontend
npm install
npm run build
```

The committed `custom_components/meshcore_chat/ha_frontend/panel.js` is what HACS ships — rebuild and commit when source changes.

## License

MIT — see [LICENSE](LICENSE).
