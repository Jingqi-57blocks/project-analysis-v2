/**
 * Splices the answers into the prepared document.
 *
 * A pure file operation — it never opens the knowledge base. Everything it
 * needs was written at prepare time, which is what makes an answer replaceable
 * one section at a time without re-running the analysis.
 *
 * A missing or invalid answer refuses by default. `--allow-missing` splices an
 * explicit admission in its place instead; either way the gap is stated, never
 * quietly closed.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { marker } from "./prepare.js";
import { validateAnswer, type AnswerProblem } from "./validate.js";
import type { Contract } from "./template.js";

interface TaskFile {
  readonly sectionId: string;
  readonly heading: string | null;
  readonly optional: boolean;
  readonly contract: Contract;
}

export interface SectionOutcome {
  readonly sectionId: string;
  readonly filled: boolean;
  readonly problems: readonly AnswerProblem[];
}

export interface AssembleResult {
  readonly markdown: string;
  readonly outcomes: readonly SectionOutcome[];
  readonly refusals: readonly AnswerProblem[];
}

export class UnansweredSectionsError extends Error {
  constructor(readonly problems: readonly AnswerProblem[]) {
    super(
      `${problems.length} section(s) cannot be assembled:\n` +
        problems.map((problem) => `  ${problem.sectionId}: ${problem.detail}`).join("\n") +
        "\nAnswer them, or pass --allow-missing to publish the document with the gaps stated.",
    );
    this.name = "UnansweredSectionsError";
  }
}

function readTasks(runDir: string): readonly TaskFile[] {
  const tasksDir = join(runDir, "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(join(tasksDir, entry.name, "task.json"), "utf8")) as TaskFile);
}

export function assemble(runDir: string, allowMissing = false): AssembleResult {
  const partialPath = join(runDir, "report.partial.md");
  if (!existsSync(partialPath)) {
    throw new Error(`No prepared document at ${partialPath}. Run \`render prepare\` first.`);
  }

  let markdown = readFileSync(partialPath, "utf8");
  const outcomes: SectionOutcome[] = [];
  const refusals: AnswerProblem[] = [];

  for (const task of readTasks(runDir)) {
    const dir = join(runDir, "tasks", task.sectionId);
    const answerPath = join(dir, "answer.md");
    const problems: AnswerProblem[] = [];
    let body: string;

    if (!existsSync(answerPath)) {
      problems.push({
        sectionId: task.sectionId,
        severity: task.optional ? "warning" : "refusal",
        detail: "no answer.md was written",
      });
      body = admission(task);
    } else {
      const answer = readFileSync(answerPath, "utf8");
      const data = JSON.parse(readFileSync(join(dir, "data.json"), "utf8")) as unknown;
      problems.push(...validateAnswer(task.sectionId, answer, task.contract, data));
      const failed = problems.some((problem) => problem.severity === "refusal");
      body = failed ? admission(task) : answer.trim();
    }

    refusals.push(...problems.filter((problem) => problem.severity === "refusal"));
    outcomes.push({
      sectionId: task.sectionId,
      filled: !problems.some((problem) => problem.severity === "refusal"),
      problems,
    });

    markdown = splice(markdown, task.sectionId, body);
  }

  if (refusals.length > 0 && !allowMissing) throw new UnansweredSectionsError(refusals);

  return { markdown, outcomes, refusals };
}

function admission(task: TaskFile): string {
  return `_This section was not written. It would have described: ${task.heading ?? task.sectionId}._`;
}

function splice(markdown: string, sectionId: string, body: string): string {
  const begin = marker(sectionId, "begin");
  const end = marker(sectionId, "end");
  const start = markdown.indexOf(begin);
  const stop = markdown.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return markdown;
  return `${markdown.slice(0, start + begin.length)}\n${body}\n${markdown.slice(stop)}`;
}

export function writeAssembled(runDir: string, result: AssembleResult): string {
  const path = join(runDir, "report.md");
  writeFileSync(path, `${result.markdown.trimEnd()}\n`, "utf8");
  writeFileSync(
    join(runDir, "assembled.json"),
    `${JSON.stringify({ outcomes: result.outcomes }, null, 2)}\n`,
    "utf8",
  );
  return path;
}
