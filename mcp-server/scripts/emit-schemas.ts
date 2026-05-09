/**
 * R-003 — emit per-tool JSON Schema artifacts to dist/schemas/inputs/.
 *
 * The PRIMARY_TOOLS array in server.ts already contains JSON-Schema-shaped
 * inputSchemas (the MCP SDK requires it). We just slice each one out and
 * write a stable, formatted .json file per tool name. Agents fetch these
 * to validate their own invocations against the same schema the server
 * uses, without re-implementing the rules in prose.
 *
 * Output:
 *   dist/schemas/inputs/<tool_name>.json   (one per tool, including orch_* aliases)
 *   dist/schemas/index.json                (manifest: tool name → schema URL)
 *
 * Determinism:
 *   - tools sorted by name
 *   - properties of each schema preserved in declaration order
 *   - 2-space indent, trailing newline
 *   - manifest emits tool count, sha256 of joined schema bytes
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname at runtime is dist/scripts/, so .. lands in dist/.
// At compile-time tsx-style runs from scripts/, but only main() actually
// touches DIST_ROOT, and main() is only invoked from dist/.
const DIST_ROOT = resolve(__dirname, '..');
const SCHEMAS_DIR = join(DIST_ROOT, 'schemas');
const INPUTS_DIR = join(SCHEMAS_DIR, 'inputs');
const INDEX_PATH = join(SCHEMAS_DIR, 'index.json');

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Load TOOLS from the BUILT server. We can't import from `../src/server.js`
 * because the script's tsconfig restricts rootDir to scripts/. Loading the
 * built artifact also keeps the script honest — we only emit schemas the
 * server actually ships.
 */
async function loadTools(): Promise<readonly ToolEntry[]> {
  const builtServerUrl = pathToFileURL(join(DIST_ROOT, 'server.js')).href;
  const mod = (await import(builtServerUrl)) as { TOOLS: readonly ToolEntry[] };
  if (!Array.isArray(mod.TOOLS)) {
    throw new Error(`emit-schemas: ${builtServerUrl} did not export TOOLS — has the build run?`);
  }
  return mod.TOOLS;
}

function emitSchema(tool: ToolEntry): { name: string; path: string; bytes: string } {
  const filename = `${tool.name}.json`;
  const filepath = join(INPUTS_DIR, filename);
  // Wrap the inputSchema in a draft-07 envelope so it's a self-describing
  // standalone JSON Schema document, not a raw fragment.
  const doc = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `https://agent-flywheel.dev/schemas/inputs/${filename}`,
    title: `flywheel: ${tool.name} input`,
    description: tool.description,
    ...(tool.inputSchema as Record<string, unknown>),
  };
  const bytes = `${JSON.stringify(doc, null, 2)}\n`;
  writeFileSync(filepath, bytes, 'utf8');
  return { name: tool.name, path: `schemas/inputs/${filename}`, bytes };
}

async function main(): Promise<void> {
  mkdirSync(INPUTS_DIR, { recursive: true });

  const tools = await loadTools();
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const entries = sorted.map(emitSchema);

  // Manifest: agents fetch this first to discover schema URLs.
  const hash = createHash('sha256');
  for (const e of entries) hash.update(e.bytes);
  const manifest = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://agent-flywheel.dev/schemas/index.json',
    title: 'flywheel input-schema manifest',
    generated_by: 'mcp-server/scripts/emit-schemas.ts',
    tool_count: entries.length,
    sha256: hash.digest('hex'),
    schemas: entries.map(({ name, path }) => ({ tool: name, path })),
  };
  writeFileSync(INDEX_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `emit-schemas: wrote ${entries.length} schema(s) → ${INPUTS_DIR}\n` +
      `             manifest sha256=${manifest.sha256}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`emit-schemas FAILED: ${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
