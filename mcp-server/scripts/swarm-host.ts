#!/usr/bin/env node

import process from "node:process";

const isCompiled = import.meta.url.includes("/dist/scripts/");
const modulePath = isCompiled ? "../swarm-host.js" : "../src/swarm-host.js";

interface SwarmHostModule {
  runSwarmHostCli: (argv: string[]) => Promise<number>;
}

const { runSwarmHostCli } = (await import(modulePath)) as SwarmHostModule;
const exitCode = await runSwarmHostCli(process.argv.slice(2));
if (exitCode !== 0) process.exit(exitCode);
