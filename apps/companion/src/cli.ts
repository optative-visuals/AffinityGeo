import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome, HomeError } from "./home.js";
import { startServer } from "./server.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const DEFAULT_PORT = 8790;

const USAGE = `Usage:
  affinitygeo serve [--port n] [--ui dir]

Starts AffinityGeo on http://127.0.0.1:${DEFAULT_PORT} (or the port you give).`;

class CliError extends Error {}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    await dispatch(argv, io);
    return 0;
  } catch (e) {
    if (e instanceof CliError || e instanceof HomeError) io.err(e.message);
    else io.err(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function dispatch(argv: string[], io: Io): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: "string" }, ui: { type: "string" } } });
  } catch (e) {
    throw new CliError(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || positionals[0] !== "serve") throw new CliError(USAGE);

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CliError("--port must be a number from 1 to 65535.");
  }
  const home = resolveHome(); // where the Affinity scripts are installed
  const srv = await startServer({ port, home, ...(values.ui ? { uiDir: resolve(values.ui) } : {}) });
  io.out(`AffinityGeo is running on http://127.0.0.1:${srv.port} — leave this window open.`);
  io.out(`Affinity scripts folder: ${home}`);
  await new Promise<void>(() => {}); // run until the process is stopped
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2), { out: (s) => console.log(s), err: (s) => console.error(s) }).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
