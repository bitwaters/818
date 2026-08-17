import type { Env } from "../env.js";
import { gmgnRequest, type GmgnResult } from "../gmgn/http.js";
import type { Chain } from "../types.js";

export async function fetchTokenSecurity(
  env: Env,
  chain: Chain,
  ca: string,
): Promise<Record<string, unknown> | null> {
  const result = await gmgnRequest<unknown>({
    path: "/v1/token/security",
    query: { chain, address: ca },
    apiKey: env.GMGN_API_KEY,
  });
  return securityFields(result);
}

export function securityFields(result: GmgnResult<unknown>): Record<string, unknown> | null {
  if (!result.ok) return null;
  const data = result.data;
  if (!data || typeof data !== "object") return null;
  const root = data as Record<string, unknown>;
  const inner =
    root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  return inner;
}
