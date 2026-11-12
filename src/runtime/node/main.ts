import { configSummary, loadNodeHostConfig, NodeHostConfigError, scrubSecretsFromEnv, startupWarnings } from "./config";
import { startNodeHost } from "./host";
import { jsonLogger, routeConsole } from "./log";

/**
 * The Node host's entry (the bundle's server.js).
 *
 * - No arguments: reads the configuration, starts the host, and stops it cleanly on SIGTERM or SIGINT (in-flight
 *   requests drain, then the database closes). A second signal exits at once. Every line of output is a JSON log line
 *   (log.ts), `console.*` of the app and its dependencies included.
 * - `access ...`, `backup <file>`, `restore <file>`: the operator's commands (access-command.ts, backup-command.ts), then exit. Its results are plain lines
 *   on stdout and stderr; anything else (`console.*`) is a JSON log line on stderr.
 *
 * No secret value is ever logged or printed.
 */

const log = jsonLogger();

async function main(): Promise<void> {
  // Files the host creates (the database and its -wal/-shm files) are owner-only.
  process.umask(0o077);
  let config;
  try {
    config = await loadNodeHostConfig(process.env);
  } catch (e) {
    if (e instanceof NodeHostConfigError) {
      log("error", "configuration error", { error: e.message });
      process.exit(78);
    }
    throw e;
  }
  scrubSecretsFromEnv(process.env);
  if (config.worker.GOOGLE_UPSTREAM === "fake") log("warn", "GOOGLE_UPSTREAM=fake: this host talks to a fake Google and is for tests only");
  log("info", "starting", configSummary(config));
  for (const warning of startupWarnings(config)) log("warn", warning);

  const host = await startNodeHost(config, log);
  if (host.migrationsApplied.length > 0) log("info", "migrations applied", { migrations: host.migrationsApplied });
  log("info", "listening", { host: host.listening.host, port: host.listening.port, publicBaseUrl: config.worker.PUBLIC_BASE_URL });

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      log("warn", "second signal: exiting now", { signal });
      process.exit(1);
    }
    stopping = true;
    log("info", "stopping", { signal });
    host.close().then(
      () => {
        log("info", "stopped");
        process.exit(0);
      },
      (e: unknown) => {
        log("error", "shutdown failed", { error: e instanceof Error ? e.message : String(e) });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function command(args: readonly string[]): Promise<void> {
  const [name, ...rest] = args;
  if (name === undefined) {
    routeConsole(log);
    return main();
  }
  if (name !== "access" && name !== "backup" && name !== "restore") {
    process.stderr.write(
      "usage: server.js                 start the server\n       server.js access ...       manage the access list\n       server.js backup <file>    copy the database\n       server.js restore <file>   replace the database from a backup\n",
    );
    process.exitCode = 64;
    return;
  }
  // The command's stdout carries only its results.
  routeConsole(jsonLogger((_stream, line) => process.stderr.write(line)));
  process.umask(0o077);
  const io = {
    out: (line: string) => process.stdout.write(`${line}\n`),
    err: (line: string) => process.stderr.write(`${line}\n`),
  };
  // Loaded only for the command, so starting the server evaluates nothing more than before.
  // exitCode, not exit(): the printed lines are flushed before the process ends.
  if (name === "access") {
    const { runAccessCommand } = await import("./access-command");
    process.exitCode = await runAccessCommand(rest, process.env, io);
  } else {
    const { runBackupCommand } = await import("./backup-command");
    process.exitCode = await runBackupCommand(name, rest, process.env, io);
  }
}

command(process.argv.slice(2)).catch((e: unknown) => {
  log("error", "startup failed", { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});
