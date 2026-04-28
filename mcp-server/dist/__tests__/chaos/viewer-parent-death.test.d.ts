/**
 * Chaos: bead-viewer must exit within ~2s when its parent dies.
 *
 * We spawn an intermediate "fake parent" Node process. The fake parent spawns
 * the viewer (so viewer.ppid === fakeParent.pid) and prints the viewer's pid.
 * We then SIGKILL the fake parent. Within 2s the viewer's parent-watch
 * (PARENT_WATCH_INTERVAL_MS=1000) detects the dead ppid and exits.
 *
 * We poll `process.kill(viewerPid, 0)` from the test to confirm the viewer
 * process is gone.
 */
export {};
//# sourceMappingURL=viewer-parent-death.test.d.ts.map