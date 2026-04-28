// @vitest-environment jsdom
/**
 * Chaos: bead body containing a script tag must NOT execute when the
 * bead-viewer renders it. Defense is `pre.textContent = JSON.stringify(body)`
 * inside the index.html click-handler — never innerHTML.
 *
 * We load the real assets/index.html, extract the inline <script>, mock
 * fetch('/api/bead/<id>') to return a malicious body, and invoke loadBead.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INDEX_HTML_PATH = resolve(
  __dirname,
  '../../../scripts/bead-viewer-assets/index.html',
);

declare global {
  // eslint-disable-next-line no-var
  var __pwn: boolean | undefined;
}

interface ViewerWindow {
  loadBead: (id: string) => Promise<void>;
  renderBead: (body: unknown) => void;
}

beforeEach(() => {
  delete (globalThis as { __pwn?: boolean }).__pwn;
  delete (window as unknown as { __pwn?: boolean }).__pwn;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  delete (globalThis as { __pwn?: boolean }).__pwn;
  delete (window as unknown as { __pwn?: boolean }).__pwn;
});

async function bootViewerScript(): Promise<ViewerWindow> {
  const html = await readFile(INDEX_HTML_PATH, 'utf8');

  const bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) throw new Error('index.html: no <body>');
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);

  document.body.innerHTML = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '');
  if (styleMatch) {
    const styleEl = document.createElement('style');
    styleEl.textContent = styleMatch[1];
    document.head.appendChild(styleEl);
  }

  // Stub cytoscape to avoid CDN load and DOM size demands.
  (window as unknown as { cytoscape: () => { on: () => void } }).cytoscape =
    () => ({ on: () => {} });

  const scriptMatch = html.match(/<script>\s*"use strict";([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('index.html: inline script not found');

  // Expose loadBead/renderBead on window. We append `;window.loadBead=loadBead;...`
  // to the end of the IIFE-free top-level script body, then evaluate it
  // (without invoking main() — strip the trailing `main();` call).
  const stripped = scriptMatch[1].replace(/\bmain\(\);?\s*$/, '');
  const evalSrc =
    stripped +
    '\nwindow.loadBead = loadBead;\nwindow.renderBead = renderBead;\n';

  // Evaluate in window scope via Function — JSDOM script handling is finicky.
  const fn = new Function(evalSrc);
  fn.call(window);

  return window as unknown as ViewerWindow;
}

describe('chaos/viewer-xss', () => {
  it('does not execute <script> in bead body when rendered', async () => {
    const v = await bootViewerScript();

    const malicious = {
      id: 'evil-1',
      title: '<script>window.__pwn=true</script>',
      body: '<script>window.__pwn=true</script>',
      notes: '<img src=x onerror="window.__pwn=true">',
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(malicious), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await v.loadBead('evil-1');

    expect((window as unknown as { __pwn?: boolean }).__pwn).toBeUndefined();
    expect((globalThis as { __pwn?: boolean }).__pwn).toBeUndefined();

    // The bead detail pane should contain the literal text, NOT a parsed <script>.
    const pre = document.querySelector('#bead-detail pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain('<script>');
    expect(document.querySelectorAll('#bead-detail script')).toHaveLength(0);
  });

  it('renderBead with a script in title still does not execute', async () => {
    const v = await bootViewerScript();
    v.renderBead({ id: 'x', title: '<script>window.__pwn=true</script>' });
    expect((window as unknown as { __pwn?: boolean }).__pwn).toBeUndefined();
    expect(document.querySelectorAll('#bead-detail script')).toHaveLength(0);
  });
});
