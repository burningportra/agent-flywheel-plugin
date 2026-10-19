#!/usr/bin/env node
import process from "node:process";
const isCompiled = import.meta.url.includes("/dist/scripts/");
const modulePath = isCompiled ? "../swarm-spawn.js" : "../src/swarm-spawn.js";
const { runCli } = (await import(modulePath));
const exitCode = await runCli(process.argv.slice(2));
if (exitCode !== 0)
    process.exit(exitCode);
//# sourceMappingURL=swarm-spawn.js.map