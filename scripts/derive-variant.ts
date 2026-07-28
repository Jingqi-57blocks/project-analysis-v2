/**
 * Materialises a modified copy of one target root, for cases the real targets
 * do not supply on their own.
 *
 *   pnpm run target:derive -- --target wcp-v2 --root wcp-auth --without-manifest
 *
 * Output lands in the gitignored `.targets/` directory. Target source is never
 * copied into the repository itself.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveVariant } from "../engine/targets/derive.js";
import { targetIds } from "../engine/targets/registry.js";
import { resolveTarget } from "../engine/targets/resolve.js";

interface Args {
  readonly target: string;
  readonly root: string;
  readonly withoutManifest: boolean;
  readonly force: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const target = value("--target");
  const root = value("--root");

  if (target === undefined || root === undefined) {
    throw new Error(
      "Usage: --target <id> --root <name> [--without-manifest] [--force]\n" +
        `Known targets: ${targetIds().join(", ")}`,
    );
  }

  return {
    target,
    root,
    withoutManifest: argv.includes("--without-manifest"),
    force: argv.includes("--force"),
  };
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const resolution = resolveTarget(args.target);

  if (!resolution.ok) {
    console.error(resolution.unavailable.reason);
    return 1;
  }

  const root = resolution.target.roots.find((r) => r.name === args.root);
  if (!root) {
    const known = resolution.target.roots.map((r) => r.name).join(", ");
    console.error(`Root "${args.root}" is not declared for "${args.target}". Declared: ${known}`);
    return 1;
  }
  if (!root.present) {
    console.error(`Root "${args.root}" is declared but not present at ${root.path}.`);
    return 1;
  }

  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const suffix = args.withoutManifest ? "no-manifest" : "copy";
  const outputDir = join(repoRoot, ".targets", `${args.target}-${args.root}-${suffix}`);

  const result = deriveVariant({
    sourceRoot: root.path,
    outputDir,
    withoutManifest: args.withoutManifest,
    force: args.force,
  });

  if (result.rebuilt) {
    console.log(`Derived ${result.outputDir}`);
    if (result.removed.length > 0) console.log(`  removed: ${result.removed.join(", ")}`);
  } else {
    console.log(`Up to date: ${result.outputDir}`);
  }

  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
