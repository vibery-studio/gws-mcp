import type { FnDef } from "../contracts";
import { accessFns } from "./access";
import { accountFns } from "./accounts";
import { generatedFns } from "./generated/index";
import { helperFns } from "./helpers/index";
import { settingsFns } from "./settings";

/** Every SDK function exposed to snippets, in registration order. */
export function registry(): FnDef[] {
  return [...generatedFns, ...helperFns, ...accountFns, ...accessFns, ...settingsFns];
}
