import { describe, it, expect } from "vitest";
import { renderPreflightBanner, PREFLIGHT_CHECK_NAMES } from "../preflight.js";

const allClear = {
  checks: [
    { name: "br_binary", severity: "green" as const, message: "v1" },
    { name: "bv_binary", severity: "green" as const, message: "v1" },
    { name: "cm_binary", severity: "green" as const, message: "v1" },
    { name: "agent_mail_liveness", severity: "green" as const, message: "200" },
    { name: "mcp_connectivity", severity: "green" as const, message: "ok" },
    { name: "projects_base_misconfig", severity: "green" as const, message: "symlinked" },
  ],
};

describe("renderPreflightBanner (T4.1)", () => {
  it("returns null when every critical check is green", () => {
    expect(renderPreflightBanner(allClear)).toBeNull();
  });

  it("returns null when only NON-critical checks are red (e.g. node_version)", () => {
    const report = {
      checks: [
        ...allClear.checks,
        { name: "node_version", severity: "red" as const, message: "v16 < 20" },
      ],
    };
    expect(renderPreflightBanner(report)).toBeNull();
  });

  it("renders a single-issue banner with tryThis surfaced", () => {
    const report = {
      checks: [
        ...allClear.checks.filter((c) => c.name !== "bv_binary"),
        {
          name: "bv_binary",
          severity: "yellow" as const,
          message: "not on PATH",
          tryThis: "brew install dicklesworthstone/tap/bv",
        },
      ],
    };
    const out = renderPreflightBanner(report)!;
    expect(out).toMatchSnapshot();
  });

  it("renders agent-mail-down with tryThis", () => {
    const report = {
      checks: [
        ...allClear.checks.filter((c) => c.name !== "agent_mail_liveness"),
        {
          name: "agent_mail_liveness",
          severity: "red" as const,
          message: "no response on :8765",
          tryThis: "am serve-http &",
        },
      ],
    };
    expect(renderPreflightBanner(report)).toMatchSnapshot();
  });

  it("renders projects_base_misconfig with ln -s tryThis", () => {
    const report = {
      checks: [
        ...allClear.checks.filter((c) => c.name !== "projects_base_misconfig"),
        {
          name: "projects_base_misconfig",
          severity: "yellow" as const,
          message: "symlink missing",
          tryThis: 'ln -s "<cwd>" "<projects_base>/<basename>"',
        },
      ],
    };
    expect(renderPreflightBanner(report)).toMatchSnapshot();
  });

  it("falls back to hint when tryThis is absent", () => {
    const report = {
      checks: [
        ...allClear.checks.filter((c) => c.name !== "br_binary"),
        { name: "br_binary", severity: "yellow" as const, message: "missing", hint: "install br" },
      ],
    };
    expect(renderPreflightBanner(report)).toMatch(/Try: install br/);
  });

  it("falls back to /flywheel-doctor pointer when both tryThis and hint absent", () => {
    const report = {
      checks: [
        ...allClear.checks.filter((c) => c.name !== "br_binary"),
        { name: "br_binary", severity: "yellow" as const, message: "missing" },
      ],
    };
    expect(renderPreflightBanner(report)).toMatch(/Try: see \/flywheel-doctor/);
  });

  it("renders a combination (br + agent-mail + projects_base) in stable order", () => {
    const report = {
      checks: [
        { name: "br_binary", severity: "yellow" as const, message: "missing", tryThis: "install br" },
        { name: "bv_binary", severity: "green" as const, message: "v1" },
        { name: "cm_binary", severity: "green" as const, message: "v1" },
        {
          name: "agent_mail_liveness",
          severity: "red" as const,
          message: "no response",
          tryThis: "am serve-http &",
        },
        { name: "mcp_connectivity", severity: "green" as const, message: "ok" },
        {
          name: "projects_base_misconfig",
          severity: "yellow" as const,
          message: "missing",
          tryThis: "ln -s ...",
        },
      ],
    };
    expect(renderPreflightBanner(report)).toMatchSnapshot();
  });

  it("PREFLIGHT_CHECK_NAMES is the 6 critical checks", () => {
    expect(PREFLIGHT_CHECK_NAMES).toEqual([
      "br_binary",
      "bv_binary",
      "cm_binary",
      "agent_mail_liveness",
      "mcp_connectivity",
      "projects_base_misconfig",
    ]);
  });
});
