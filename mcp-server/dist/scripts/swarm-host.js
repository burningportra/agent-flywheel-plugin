#!/usr/bin/env node
import process from "node:process";
const isCompiled = import.meta.url.includes("/dist/scripts/");
const modulePath = isCompiled ? "../swarm-host.js" : "../src/swarm-host.js";
const { runSwarmHostCli } = (await import(modulePath));
const exitCode = await runSwarmHostCli(process.argv.slice(2));
if (exitCode !== 0)
    process.exit(exitCode);
//# sourceMappingURL=swarm-host.js.map