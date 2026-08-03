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
    "Read the claim set. Do not open the pack — the claims phase already walked it.",
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
  readonly session_id?: string;
  readonly message?: { readonly content?: readonly Record<string, unknown>[] };
}

/**
 * The agent's session, if this line names one.
 *
 * Every stream line carries it, and it is what makes a dropped connection
 * recoverable: re-spawning with `--resume` continues the same conversation
 * instead of starting a new one. Without it a drop at minute twenty costs all
 * twenty minutes and the tokens that went with them.
 */
export function sessionIdFrom(line: string): string | null {
  try {
    const event = JSON.parse(line) as StreamEvent;
    return typeof event.session_id === "string" && event.session_id.length > 0 ? event.session_id : null;
  } catch {
    return null;
  }
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

/**
 * Failures worth trying again.
 *
 * A dropped connection says nothing about whether the work is possible, and one
 * flaky moment should not cost a whole authoring call. A refusal, a bad
 * argument or a crash inside the agent is a different matter — retrying those
 * just spends the same quota twice for the same answer.
 */
const TRANSIENT = /connection|ECONNRESET|ETIMEDOUT|ENETDOWN|ENETUNREACH|socket hang up|network|502|503|504|overloaded|rate.?limit/i;

export function isTransientFailure(message: string): boolean {
  return TRANSIENT.test(message) && !isQuotaExhausted(message);
}

/**
 * A spent quota window, which is not a transient failure.
 *
 * Retrying in five seconds cannot help: the window reopens at a stated time, and
 * three doomed attempts only add noise to the log. Treated as its own outcome so
 * the caller can say when work may continue instead of reporting a failure that
 * looks like a defect.
 */
const QUOTA_EXHAUSTED = /(session|usage|weekly) limit|limit reached|resets? \d/i;

export function isQuotaExhausted(message: string): boolean {
  return QUOTA_EXHAUSTED.test(message);
}

/** The reset time the message states, verbatim, or null. */
export function quotaResetFrom(message: string): string | null {
  const match = /resets? ([^·\n]+)/i.exec(message);
  return match?.[1]?.trim() ?? null;
}

/**
 * The reason an agent stopped, from its own terminating event.
 *
 * The CLI reports a spent quota through the stream and leaves stderr empty, so a
 * caller that only reads stderr learns nothing but the exit code — which is how a
 * stop the caller needed to understand became a bare `exit 1`.
 */
export function failureReasonFrom(line: string): string | null {
  try {
    const event = JSON.parse(line) as { type?: string; is_error?: boolean; result?: unknown };
    if (event.type !== "result" || event.is_error !== true) return null;
    return typeof event.result === "string" && event.result.length > 0 ? event.result : null;
  } catch {
    return null;
  }
}

export class QuotaExhaustedError extends Error {
  constructor(
    readonly specId: string,
    readonly resetsAt: string | null,
  ) {
    super(
      resetsAt === null
        ? `quota exhausted while authoring ${specId}; resume this run when it reopens`
        : `quota exhausted while authoring ${specId}; resume this run after ${resetsAt}`,
    );
    this.name = "QuotaExhaustedError";
  }
}

const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * Spawns the `claude` CLI in the repository, with the tools the skill needs,
 * retrying a transient failure a few times before giving up.
 */
export function claudeSkillRunner(model = "default"): SkillRunner {
  return async (invocation) => {
    let lastError: unknown;
    /** Set once the agent announces itself, so a retry can continue it. */
    let session: string | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const seen: { sessionId: string | null } = { sessionId: session };
      try {
        return await spawnClaude(model, seen)(invocation);
      } catch (error) {
        lastError = error;
        session = seen.sessionId;
        const message = error instanceof Error ? error.message : String(error);
        if (isQuotaExhausted(message)) {
          // Not a defect and not worth retrying: say when work may continue.
          throw new QuotaExhaustedError(invocation.specId, quotaResetFrom(message));
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isTransientFailure(message)) break;
        invocation.onProgress?.({
          elapsedMs: 0,
          kind: "start",
          detail:
            session === null
              ? `transient failure, restarting in ${delay / 1000}s: ${message.slice(0, 100)}`
              : `connection lost, continuing session ${session.slice(0, 8)} in ${delay / 1000}s`,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  };
}

/**
 * One spawn.
 *
 * `seen` is written as the stream reveals the session id and read by the caller
 * on failure — a dropped connection then resumes that conversation rather than
 * paying for it twice. A drop at minute twenty of a twenty-one-minute call cost
 * $9 and the whole twenty minutes; continuing costs the remainder.
 */
function spawnClaude(model: string, seen: { sessionId: string | null }): SkillRunner {
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
        //
        // `Bash` is here because the pack is line-oriented JSONL and filtering it
        // is what `jq` is for. Denying it does not stop the agent needing it —
        // one run made 77 attempts, had 13 refused, and burned turns rewriting
        // around the refusals. The boundary that matters is the pack: the agent
        // is given the facts it may use, and the audit checks what it cited.
        "--allowedTools",
        "Skill,Read,Grep,Glob,Write,Bash",
        ...(model === "default" ? [] : ["--model", model]),
        // Continue the interrupted conversation rather than paying for it again.
        ...(seen.sessionId === null ? [] : ["--resume", seen.sessionId]),
      ];
      const child = spawn("claude", args, { cwd: invocation.repoRoot, stdio: ["pipe", "pipe", "pipe"] });
      const transcript = invocation.transcriptPath;
      const started = Date.now();
      let stderr = "";
      let pending = "";
      let lastReported = "";
      let failureDetail = "";
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
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          // Recorded even with no progress listener: it is what makes a dropped
          // connection resumable, which matters whether or not anyone is watching.
          if (seen.sessionId === null) seen.sessionId = sessionIdFrom(line);
          const reason = failureReasonFrom(line);
          if (reason !== null) failureDetail = reason;
        }
        if (invocation.onProgress === undefined) return;
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
        if (code === 0) {
          resolve({ modelTier: model });
          return;
        }
        // The reason lives in the stream's own result event, not in stderr —
        // stderr came back empty on a quota exhaustion, so `exit 1` was all the
        // caller was told about a stop it needed to understand.
        const detail = failureDetail.length > 0 ? failureDetail : stderr.slice(-2000);
        reject(new SkillRunError(invocation.specId, `exit ${code}: ${detail}`));
      });
      touch();
      child.stdin.end(buildSkillPrompt(invocation));
    });
}
