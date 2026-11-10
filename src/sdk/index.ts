import type { FnDef } from "../contracts";
import { accountFns } from "./accounts";
import { generatedFns } from "./generated/index";
import { helperFns } from "./helpers/index";

/** Every SDK function exposed to snippets, in registration order. */
export function registry(): FnDef[] {
  return [...generatedFns, ...helperFns, ...accountFns];
}
