#!/usr/bin/env node

import process from "node:process";
import { runCli } from "../mcp-server/dist/scripts/tender-daemon.js";

const exitCode = await runCli(process.argv.slice(2));
if (exitCode !== 0) process.exit(exitCode);
