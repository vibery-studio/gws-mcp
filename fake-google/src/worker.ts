import { env } from "cloudflare:workers";
import { fakeOptions, type FakeEnv } from "./do-store";

export { FakeState } from "./do-store";

// Startup check: the Worker fails to start (and to deploy) without its secrets, rather than serving open
// control routes. The module-level env is typed as the main Worker's; only the three secret names are read.
fakeOptions(env as unknown as Partial<Record<string, unknown>>);

/** The deployed fake Google: every request goes to the single FakeState instance. */
export default {
  fetch(request: Request, workerEnv: FakeEnv): Promise<Response> {
    const stub = workerEnv.FAKE_STATE.get(workerEnv.FAKE_STATE.idFromName("fake"));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<FakeEnv>;
