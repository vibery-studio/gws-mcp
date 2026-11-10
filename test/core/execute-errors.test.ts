import { env } from "cloudflare:workers";
import { loadConfig } from "../../src/config";
import { workersSandbox } from "../../src/runtime/workers/sandbox";
import { executeErrorCases } from "../shared/execute-error-cases";

executeErrorCases("Workers sandbox", { sandbox: () => workersSandbox(env.LOADER), config: loadConfig(env) });
