#!/usr/bin/env node

import process from "node:process";

const isCompiled = import.meta.url.includes("/dist/scripts/");
const modulePath = isCompiled ? "../swarm-spawn.js" : "../src/swarm-spawn.js";

interface SwarmSpawnModule {
  runCli: (argv: string[]) => Promise<number>;
}

const { runCli } = (await import(modulePath)) as SwarmSpawnModule;
const exitCode = await runCli(process.argv.slice(2));
if (exitCode !== 0) process.exit(exitCode);
