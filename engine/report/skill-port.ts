/**
 * The port through which the report skill is invoked.
 *
 * The existing JSON authoring port runs its agent in an empty directory and takes
 * back one structured value. The skill needs the opposite shape: it runs in the
 * repository so it can read the contracts and the fact pack, and its result is
 * the two files it writes. So this is a second, narrow port rather than a
 * widening of the first.
 *
 * The port is model-agnostic. The default implementation shells out to the
 * `claude` CLI; a caller may inject any runner, which is how the pipeline is
 * tested without spending a model call.
 */

import { spawn } from "node:child_process";

export interface SkillInvocation {
  /** Directory holding `index.json`, `kinds/*.jsonl` and `subjects.jsonl`. */
  readonly packDir: string;
  readonly specId: string;
  readonly language: string;
  readonly claimsPath: string;
  readonly viewPath: string;
  /** Repository root — the skill reads its contracts from here. */
  readonly repoRoot: string;
}

export interface SkillOutcome {
  /** The tier that authored it, recorded in the manifest so runs stay comparable. */
  readonly modelTier: string;
}

export type SkillRunner = (invocation: SkillInvocation) => Promise<SkillOutcome>;

export class SkillRunError extends Error {
  constructor(
    readonly specId: string,
    detail: string,
  ) {
    super(`report skill failed for ${specId}: ${detail}`);
    this.name = "SkillRunError";
  }
}

/**
 * The instruction handed to the agent.
 *
 * It names the skill and its inputs and nothing else: what to do is the skill's
 * to say, and restating it here would create a second copy that drifts from
 * `SKILL.md`.
 */
export function buildSkillPrompt(invocation: SkillInvocation): string {
  return [
    "Use the project-report skill.",
    "",
    `packPath: ${invocation.packDir}/index.json`,
    `specId: ${invocation.specId}`,
    `language: ${invocation.language}`,
    `claimsPath: ${invocation.claimsPath}`,
    `viewPath: ${invocation.viewPath}`,
    "",
    "Follow SKILL.md exactly. Write both files, then report the two paths.",
  ].join("\n");
}

const IDLE_TIMEOUT_MS = 300_000;

/** Spawns the `claude` CLI in the repository, with the tools the skill needs. */
export function claudeSkillRunner(model = "default"): SkillRunner {
  return async (invocation) =>
    new Promise<SkillOutcome>((resolve, reject) => {
      const args = [
        "--print",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,Grep,Glob,Write",
        ...(model === "default" ? [] : ["--model", model]),
      ];
      const child = spawn("claude", args, { cwd: invocation.repoRoot, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      let idle: NodeJS.Timeout | undefined;
      const touch = (): void => {
        if (idle !== undefined) clearTimeout(idle);
        idle = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new SkillRunError(invocation.specId, `no output for ${IDLE_TIMEOUT_MS / 1000}s`));
        }, IDLE_TIMEOUT_MS);
      };
      child.stdout.on("data", touch);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        touch();
      });
      child.on("error", (error) => reject(new SkillRunError(invocation.specId, error.message)));
      child.on("close", (code) => {
        if (idle !== undefined) clearTimeout(idle);
        if (code === 0) resolve({ modelTier: model });
        else reject(new SkillRunError(invocation.specId, `exit ${code}: ${stderr.slice(-2000)}`));
      });
      touch();
      child.stdin.end(buildSkillPrompt(invocation));
    });
}
