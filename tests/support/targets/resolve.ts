import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { envVarFor, findTarget, targetIds } from "./registry.js";
import type { ResolvedRoot, TargetResolution } from "./types.js";

export interface ResolveOptions {
  /** Defaults to `process.env`. Injectable so tests need not mutate globals. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Expands a leading `~` and returns an absolute path. */
export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Locates a target on disk.
 *
 * Absence is a normal outcome, not an exception: these are real projects that
 * live outside the repository and are not present on every machine. Callers
 * skip on `ok: false` and print `reason`, so a skipped test suite explains
 * itself instead of appearing to pass.
 */
export function resolveTarget(id: string, options: ResolveOptions = {}): TargetResolution {
  const env = options.env ?? process.env;
  const definition = findTarget(id);

  if (!definition) {
    return {
      ok: false,
      unavailable: {
        id,
        reason: `Unknown target "${id}". Known targets: ${targetIds().join(", ")}.`,
      },
    };
  }

  const envVar = envVarFor(id);
  const override = env[envVar];
  const path = expandPath(override ?? definition.defaultPath);

  if (!isDirectory(path)) {
    const source = override ? `${envVar}=${override}` : `default path ${definition.defaultPath}`;
    return {
      ok: false,
      unavailable: {
        id,
        reason: `Target "${id}" not found at ${path} (from ${source}). Set ${envVar} to override.`,
      },
    };
  }

  const roots: ResolvedRoot[] = definition.roots.map((name) => {
    const rootPath = join(path, name);
    const present = isDirectory(rootPath);
    return {
      name,
      path: rootPath,
      present,
      isGitRepo: present && existsSync(join(rootPath, ".git")),
    };
  });

  return {
    ok: true,
    target: {
      id,
      path,
      vcs: definition.vcs,
      roots,
      missingRoots: roots.filter((r) => !r.present).map((r) => r.name),
    },
  };
}
