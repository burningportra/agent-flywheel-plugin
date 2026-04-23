---
title: "BOM+CRLF fixture"
tags: ["test", "i72"]
---

# Heading

This fixture intentionally has UTF-8 BOM and CRLF line endings to exercise the
normalizeText() boundary in mcp-server. After normalize the BOM should be gone
and all CRLFs collapsed to LF.
