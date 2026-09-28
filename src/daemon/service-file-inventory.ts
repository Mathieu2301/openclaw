/** Native service-file inventory reads and their completeness evidence. */
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

export type ServiceFileInspectionError = { source: string; message: string };

type ServiceFileEntry = {
  entry: string;
  name: string;
  fullPath: string;
  contents: Buffer;
};

export async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  isPotentialName: (name: string) => boolean;
  requireComplete?: boolean;
  errors?: ServiceFileInspectionError[];
}): Promise<ServiceFileEntry[]> {
  const out: ServiceFileEntry[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(params.dir);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      params.errors?.push({ source: params.dir, message: "Service path could not be inspected." });
    }
    return out;
  }
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(params.extension)) {
      continue;
    }
    const name = entry.slice(0, -params.extension.length);
    const fullPath = path.join(params.dir, entry);
    let contents: Buffer;
    try {
      contents = await fs.readFile(fullPath);
    } catch {
      if (params.requireComplete || params.isPotentialName(name)) {
        params.errors?.push({ source: fullPath, message: "Service path could not be inspected." });
      }
      continue;
    }
    out.push({ entry, name, fullPath, contents });
  }
  return out;
}
