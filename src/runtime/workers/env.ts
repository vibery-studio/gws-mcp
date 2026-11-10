import { SECRET_NAMES, type SecretName } from "../../contracts";

/** Every secret the core names is a binding of the Worker env (`tsc` fails here otherwise). */
SECRET_NAMES satisfies readonly (keyof Env)[];

/** The Worker env without the secrets. Host fns get no env at all (see `CallCtx`); this types secret-free env copies. */
export type HostEnv = Omit<Env, SecretName>;

/**
 * Copies `env` without the secret bindings. The `HostEnv` type alone is not enough: a full `Env`
 * is structurally assignable to it.
 */
export function omitSecrets(env: Env): HostEnv {
  const host: Record<string, unknown> = { ...env };
  for (const name of SECRET_NAMES) delete host[name];
  return host as HostEnv;
}
