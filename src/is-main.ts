import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isMainModule(metaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  return metaUrl === pathToFileURL(resolve(argv1)).href;
}
