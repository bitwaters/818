import type { Env } from "../env.js";
import { gmgnRequest } from "../gmgn/http.js";
import type { Chain } from "../types.js";
import { parseTokenInfoMc } from "./parse.js";

export async function fetchTokenInfoMc(env: Env, chain: Chain, ca: string): Promise<number | null> {
  const result = await gmgnRequest({
    path: "/v1/token/info",
    query: { chain, address: ca },
    apiKey: env.GMGN_API_KEY,
  });
  if (!result.ok) return null;
  return parseTokenInfoMc(result.data);
}
