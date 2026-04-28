---
description: Open the bead-graph visualizer in your browser.
---

Launch the read-only bead-graph viewer.

The viewer renders `br list --json` + `br dep list --json` as a Cytoscape graph
with cycle highlighting and click-to-detail. Read-only — no PATCH/POST routes.

## Invocation

```bash
cd <project-root>
node mcp-server/dist/scripts/bead-viewer.js --port 0   # ephemeral port (default)
node mcp-server/dist/scripts/bead-viewer.js --port 7331  # fixed port
node mcp-server/dist/scripts/bead-viewer.js --no-open    # don't auto-launch browser
```

Or via npm script:

```bash
cd mcp-server && npm run bead-viewer
```

## Security
- Hard-bound to `127.0.0.1`. `FW_VIEWER_BIND` overrides are refused unless they match a loopback alias (`127.0.0.1`, `localhost`, `::1`).
- Per-IP rate limit (30 req/s) + connection cap (16 concurrent) + 60s per-conn timeout.
- Bead bodies served as JSON only, never inlined into HTML — XSS-safe.
- Exits within 2s of parent process death (parent-pid watch).
