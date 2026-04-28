/**
 * Chaos: bead body containing a script tag must NOT execute when the
 * bead-viewer renders it. Defense is `pre.textContent = JSON.stringify(body)`
 * inside the index.html click-handler — never innerHTML.
 *
 * We load the real assets/index.html, extract the inline <script>, mock
 * fetch('/api/bead/<id>') to return a malicious body, and invoke loadBead.
 */
declare global {
    var __pwn: boolean | undefined;
}
export {};
//# sourceMappingURL=viewer-xss.test.d.ts.map