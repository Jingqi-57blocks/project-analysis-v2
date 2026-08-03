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
import { appendFileSync } from "node:fs";

/**
 * Which half of the work an invocation performs.
 *
 * `claims` runs once over the whole pack: two workers deriving conclusions
 * separately would each invent a wording for the same finding, and the pack —
 * not the chapter list — is the unit that keeps them consistent.
 *
 * `chapter` runs once per chapter, and they run concurrently. That is safe only
 * because every chapter draws on the same claim set, so two chapters cannot
 * contradict each other however independently they were written.
 */
export type SkillPhase = "claims" | "chapter";

export interface ChapterAssignment {
  readonly number: string;
  readonly title: string;
  readonly slug: string;
  /** The chapter's own text from the spec — all a worker needs beyond the contract. */
  readonly body: string;
  readonly outputPath: string;
}

export interface SkillInvocation {
  readonly phase: SkillPhase;
  /** Present exactly when the phase is `chapter`. */
  readonly chapter?: ChapterAssignment;
  /** Directory holding `index.json`, `kinds/*.jsonl` and `subjects.jsonl`. */
  readonly packDir: string;
  readonly specId: string;
  readonly language: string;
  readonly claimsPath: string;
  readonly viewPath: string;
  /** Repository root — the skill reads its contracts from here. */
  readonly repoRoot: string;
  /**
   * Where intermediate files go.
   *
   * An agent working through a large pack writes helper scripts and partial
   * results. Without somewhere to put them it scatters them wherever it happens
   * to be, and nobody cleans up: a failed run left seventeen stray files in the
   * output root. Naming the directory makes them collectable.
   */
  readonly scratchDir: string;
  /** Where to keep the agent's stream, so a failed run can be diagnosed. */
  readonly transcriptPath?: string;
  readonly onProgress?: (event: SkillProgress) => void;
}

/**
 * A readable account of what the agent is doing right now.
 *
 * A long authoring call is otherwise a black box: the two runs that timed out
 * gave five minutes of silence and no way to tell a slow read from a hung
 * process. Every tool call the agent makes becomes one of these.
 */
export interface SkillProgress {
  /** Milliseconds since the call started. */
  readonly elapsedMs: number;
  readonly kind: "start" | "tool" | "thinking" | "done";
  readonly detail: string;
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
  const common = [
    "Use the project-report skill.",
    "",
    `phase: ${invocation.phase}`,
    `packPath: ${invocation.packDir}/index.json`,
    `specId: ${invocation.specId}`,
    `language: ${invocation.language}`,
    `claimsPath: ${invocation.claimsPath}`,
    `scratchPath: ${invocation.scratchDir}`,
  ];
  if (invocation.phase === "claims") {
    return [...common, "", "Follow SKILL.md exactly. Write the claim set, then report its path."].join("\n");
  }
  const chapter = invocation.chapter;
  return [
    ...common,
    `chapterNumber: ${chapter?.number ?? ""}`,
    `chapterTitle: ${chapter?.title ?? ""}`,
    `chapterOutputPath: ${chapter?.outputPath ?? ""}`,
    "",
    "This chapter's part of the spec:",
    "",
    chapter?.body ?? "",
    "",
    "Follow SKILL.md exactly. Write this one chapter, then report its path.",
  ].join("\n");
}

const IDLE_TIMEOUT_MS = 600_000;

/** The one field that names what a tool call is acting on, per tool. */
const TOOL_SUBJECT: Readonly<Record<string, string>> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Glob: "pattern",
  Grep: "pattern",
};

function describeTool(name: string, input: Record<string, unknown>): string {
  const field = TOOL_SUBJECT[name];
  const subject = field === undefined ? undefined : input[field];
  return typeof subject === "string" ? `${name} ${subject}` : name;
}

interface StreamEvent {
  readonly type?: string;
  readonly subtype?: string;
  readonly message?: { readonly content?: readonly Record<string, unknown>[] };
}

/**
 * Turns one stream line into progress, or into nothing.
 *
 * Exported because the shape of these events is the only thing standing between
 * a long run and an unexplained wait, so it is worth testing directly rather
 * than through a spawned process.
 */
export function progressFrom(line: string, elapsedMs: number): SkillProgress | null {
  let event: StreamEvent;
  try {
    event = JSON.parse(line) as StreamEvent;
  } catch {
    return null;
  }
  if (event.type === "system" && event.subtype === "init") {
    return { elapsedMs, kind: "start", detail: "agent started" };
  }
  if (event.type === "result") {
    return { elapsedMs, kind: "done", detail: "agent finished" };
  }
  for (const block of event.message?.content ?? []) {
    if (block["type"] === "tool_use" && typeof block["name"] === "string") {
      const input = (block["input"] ?? {}) as Record<string, unknown>;
      return { elapsedMs, kind: "tool", detail: describeTool(block["name"], input) };
    }
    if (block["type"] === "thinking") return { elapsedMs, kind: "thinking", detail: "reasoning" };
  }
  return null;
}

/** Spawns the `claude` CLI in the repository, with the tools the skill needs. */
export function claudeSkillRunner(model = "default"): SkillRunner {
  return async (invocation) =>
    new Promise<SkillOutcome>((resolve, reject) => {
      // Streaming is not cosmetic: `--print` alone emits nothing until the very
      // end, so an idle-timeout would kill every long authoring call. The stream
      // gives a liveness signal, which is what distinguishes a slow run from a
      // hung one whatever the report's size — but only with partial messages:
      // without them a long stretch of reasoning between tool calls emits
      // nothing, and silence stops meaning what the timeout assumes it means.
      const args = [
        "--print",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        // `Skill` is not optional: without it the agent cannot invoke the very
        // skill it was asked for, and the call stalls instead of failing loudly.
        "--allowedTools",
        "Skill,Read,Grep,Glob,Write",
        ...(model === "default" ? [] : ["--model", model]),
      ];
      const child = spawn("claude", args, { cwd: invocation.repoRoot, stdio: ["pipe", "pipe", "pipe"] });
      const transcript = invocation.transcriptPath;
      const started = Date.now();
      let stderr = "";
      let pending = "";
      let lastReported = "";
      let idle: NodeJS.Timeout | undefined;
      const touch = (): void => {
        if (idle !== undefined) clearTimeout(idle);
        idle = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new SkillRunError(invocation.specId, `no output for ${IDLE_TIMEOUT_MS / 1000}s`));
        }, IDLE_TIMEOUT_MS);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (transcript !== undefined) appendFileSync(transcript, chunk);
        touch();
        if (invocation.onProgress === undefined) return;
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const event = progressFrom(line, Date.now() - started);
          // Partial-message streaming repeats a tool call across many events;
          // reporting each one would bury the change of activity in noise.
          if (event === null || event.detail === lastReported) continue;
          lastReported = event.detail;
          invocation.onProgress(event);
        }
      });
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
