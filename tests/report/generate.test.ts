import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { loadSpecRegistry } from "../../engine/contracts/report/specs.js";
import type { ModuleDirectory } from "../../engine/contracts/module/index.js";
import { generateReports, explainRun } from "../../engine/report/generate.js";
import { planReport } from "../../engine/report/orchestrate.js";
import {
  buildSkillPrompt,
  failureReasonFrom,
  isQuotaExhausted,
  isTransientFailure,
  progressFrom,
  quotaResetFrom,
  sessionIdFrom,
  type SkillRunner,
} from "../../engine/report/skill-port.js";

const INSTANT = new Date("2026-08-03T06:22:00.000Z");
let store: Store;
let snapshotId: number;

const directory: ModuleDirectory = {
  identities: [
    { id: "mod_a", structuralName: "leaves", category: "product-capability", rootNames: ["svc"], aliases: [] },
  ],
  displayNames: [],
};

beforeEach(() => {
  store = openStore(IN_MEMORY);
  store.run("INSERT INTO workspaces (path, created_at) VALUES ('/w', 't0')");
  store.run("INSERT INTO snapshots (workspace_id, identity, created_at, published_at) VALUES (1, 'i', 't0', NULL)");
  snapshotId = store.get<{ id: number }>("SELECT id FROM snapshots")!.id;
  store.run("INSERT INTO source_roots (snapshot_id, name, path, content_digest) VALUES (?, 'svc', '/w/svc', 'd')", [snapshotId]);
  store.run("INSERT INTO files (source_root_id, rel_path, size_bytes, disposition) VALUES (1, 'a.go', 10, 'analyzed')");
  // The gate's mandatory kinds.
  for (const [kind, key] of [["run-context", "rc"], ["coverage-note", "cn"]] as const) {
    store.run(
      "INSERT INTO derived_records (snapshot_id, kind, record_key, payload) VALUES (?, ?, ?, ?)",
      [snapshotId, kind, key, JSON.stringify({ id: key })],
    );
  }
  store.run(
    "INSERT INTO structural_records (snapshot_id, source_root_id, kind, record_key, payload, resolution_class, rel_path) VALUES (?, 1, 'route', 'r1', ?, 'resolved', 'a.go')",
    [snapshotId, JSON.stringify({ rootName: "svc" })],
  );
});

function plan(targets: Parameters<typeof planReport>[0]["targets"]) {
  const result = planReport({ targets, language: "zh-CN", format: "markdown" }, loadSpecRegistry(), directory);
  if (!result.ok) throw new Error(JSON.stringify(result.failures));
  return result.plan;
}

/**
 * Writes a clean report and a valid claim set, the way a good run would —
 * including drawing on every kind the pack offers. A run that never touched the
 * coverage ledger is supposed to fail, so a stub that skipped it would be
 * testing the wrong thing.
 */
const goodRunner: SkillRunner = async (invocation) => {
  if (invocation.phase === "claims") {
    const claim = (predicate: string, type: string, ref: string, factIds: readonly string[]) => ({
      predicate,
      subject: { type, ref },
      qualifiers: {},
      factIds,
    });
    writeFileSync(
      invocation.claimsPath,
      JSON.stringify({
        claims: [
          claim("route-declared", "route", "r1", ["r1"]),
          claim("coverage-recorded", "workspace", ".", ["cn"]),
          claim("snapshot-recorded", "workspace", "snapshot", ["rc"]),
        ],
      }),
    );
    return { modelTier: "sonnet" };
  }
  writeFileSync(invocation.chapter!.outputPath, `## ${invocation.chapter!.title}\n\n一条路由声明于 a.go。\n`);
  return { modelTier: "sonnet" };
};

function run(targets: Parameters<typeof planReport>[0]["targets"], runSkill: SkillRunner) {
  return generateReports({
    plan: plan(targets),
    store,
    snapshotId,
    snapshotIdentity: "run-1",
    outputRoot: mkdtempSync(join(tmpdir(), "runs-")),
    repoRoot: process.cwd(),
    instant: INSTANT,
    runSkill,
    membership: new Map([["mod_a", { files: new Set(["svc/a.go"]), subjectKeys: new Set(["mod_a"]) }]]),
  });
}

describe("running a plan", () => {
  it("produces a deliverable when the skill writes a clean report", async () => {
    const result = await run([{ scope: "project", audience: "product" }], goodRunner);
    expect(result.delivered).toBe(true);
    expect(existsSync(join(result.runPath, "project-product/report.md"))).toBe(true);
    expect(existsSync(join(result.runPath, "project-product/claims.json"))).toBe(true);
    expect(existsSync(join(result.runPath, "project-product/audit.json"))).toBe(true);
  });

  it("writes a manifest recording the tier and the verdict", async () => {
    const result = await run([{ scope: "project", audience: "product" }], goodRunner);
    const manifest = JSON.parse(readFileSync(join(result.runPath, "manifest.json"), "utf8"));
    expect(manifest.modelTier).toBe("sonnet");
    expect(manifest.auditPassed).toBe(true);
    expect(manifest.startedAtLocal).toBe("08-03 14:22");
    expect(manifest.targets[0].specVersion).toBe("1.1.0");
  });

  it("cuts one pack for two audiences over the same module", async () => {
    const result = await run(
      [
        { scope: "module", audience: "product", module: "leave" },
        { scope: "module", audience: "developer", module: "leave" },
      ],
      goodRunner,
    );
    expect(result.outcomes).toHaveLength(2);
    expect(existsSync(join(result.runPath, "packs/module-mod_a/index.json"))).toBe(true);
  });

  it("cuts a shared pack once even when both targets reach it at the same moment", async () => {
    // Targets run concurrently, so caching the resulting path would let both
    // find nothing cached and both write the pack over each other. The cache
    // holds the work, not the result.
    let cuts = 0;
    const counting: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") cuts += 1;
      return goodRunner(invocation);
    };
    const result = await run(
      [
        { scope: "module", audience: "product", module: "leave" },
        { scope: "module", audience: "developer", module: "leave" },
      ],
      counting,
    );
    // Two targets, so two claim passes — but one pack directory between them.
    expect(cuts).toBe(2);
    expect(result.outcomes.every((outcome) => outcome.blocked === null)).toBe(true);
  });

  it("runs targets concurrently rather than queueing them", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: SkillRunner = async (invocation) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return goodRunner(invocation);
    };
    await run(
      [
        { scope: "project", audience: "product" },
        { scope: "module", audience: "product", module: "leave" },
      ],
      slow,
    );
    // Targets are independent by construction; making them queue only spends
    // wall clock.
    expect(peak).toBeGreaterThan(1);
  });

  it("fails the run when the report cites a file that was never read", async () => {
    const fabricating: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") {
        writeFileSync(invocation.claimsPath, JSON.stringify({ claims: [] }));
        return { modelTier: "haiku" };
      }
      writeFileSync(invocation.chapter!.outputPath, "已验证位置：holidays.py\n");
      return { modelTier: "haiku" };
    };
    const result = await run([{ scope: "project", audience: "product" }], fabricating);
    expect(result.delivered).toBe(false);
    expect(result.manifest.auditPassed).toBe(false);
    expect(explainRun(result)).toContain("AUDIT FAILED");
  });

  it("fails the run when a claim has no supporting facts", async () => {
    const unsupported: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") {
        writeFileSync(
          invocation.claimsPath,
          JSON.stringify({ claims: [{ predicate: "p", subject: { type: "entity", ref: "t" }, qualifiers: {}, factIds: [] }] }),
        );
        return { modelTier: "sonnet" };
      }
      writeFileSync(invocation.chapter!.outputPath, "## 章\n");
      return { modelTier: "sonnet" };
    };
    const result = await run([{ scope: "project", audience: "product" }], unsupported);
    expect(result.delivered).toBe(false);
  });

  it("produces nothing, and says so, when the skill fails", async () => {
    const failing: SkillRunner = async () => {
      throw new Error("the model went away");
    };
    const result = await run([{ scope: "project", audience: "product" }], failing);
    expect(result.delivered).toBe(false);
    expect(result.outcomes[0]?.blocked).toContain("the model went away");
    expect(explainRun(result)).toContain("NOT PRODUCED");
  });

  it("produces nothing when a chapter is not written", async () => {
    const silent: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") writeFileSync(invocation.claimsPath, JSON.stringify({ claims: [] }));
      return { modelTier: "sonnet" };
    };
    const result = await run([{ scope: "project", audience: "product" }], silent);
    expect(result.outcomes[0]?.blocked).toContain("chapters not written");
  });

  it("clears the agent's intermediates once a report exists", async () => {
    // A failed run left seventeen stray files in the output root, because the
    // agent had nowhere named to put them and nobody knew which were its.
    const messy: SkillRunner = async (invocation) => {
      writeFileSync(join(invocation.scratchDir, "helper.jq"), "{}");
      return goodRunner(invocation);
    };
    const result = await run([{ scope: "project", audience: "product" }], messy);
    expect(result.delivered).toBe(true);
    expect(existsSync(join(result.runPath, "scratch"))).toBe(false);
  });

  it("keeps the intermediates when the run produced nothing", async () => {
    const messyAndFailing: SkillRunner = async (invocation) => {
      writeFileSync(join(invocation.scratchDir, "helper.jq"), "{}");
      if (invocation.phase === "claims") writeFileSync(invocation.claimsPath, JSON.stringify({ claims: [] }));
      return { modelTier: "sonnet" };
    };
    const result = await run([{ scope: "project", audience: "product" }], messyAndFailing);
    expect(result.delivered).toBe(false);
    expect(existsSync(join(result.runPath, "scratch/helper.jq"))).toBe(true);
  });

  it("never reuses a run directory", async () => {
    const first = await run([{ scope: "project", audience: "product" }], goodRunner);
    const second = await generateReports({
      plan: plan([{ scope: "project", audience: "product" }]),
      store,
      snapshotId,
      snapshotIdentity: "run-1",
      outputRoot: join(first.runPath, ".."),
      repoRoot: process.cwd(),
      instant: INSTANT,
      runSkill: goodRunner,
      membership: new Map(),
    });
    expect(second.runId).not.toBe(first.runId);
    expect(existsSync(join(first.runPath, "manifest.json"))).toBe(true);
  });
});

describe("the skill prompt", () => {
  it("names the inputs and defers everything else to SKILL.md", () => {
    const prompt = buildSkillPrompt({
      phase: "claims", packDir: "/p", specId: "project-product", language: "zh-CN",
      claimsPath: "/c.json", viewPath: "/v.md", repoRoot: "/repo", scratchDir: "/repo/scratch",
    });
    for (const line of ["packDb: /p/pack.sqlite", "specId: project-product", "language: zh-CN", "scratchPath: /repo/scratch"]) {
      expect(prompt).toContain(line);
    }
    // Restating the skill's rules here would create a second copy that drifts.
    expect(prompt).not.toContain("MUST");
    expect(prompt).toContain("Follow SKILL.md exactly");
  });
});

describe("kind usage is measured through claims, not through prose", () => {
  it("notices a kind the claims never draw on, without failing the run for it", async () => {
    // The fabricating run in the trial never queried the coverage ledger or the
    // computed findings, and still wrote the chapters they feed.
    const skipsLedger: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") {
        writeFileSync(
          invocation.claimsPath,
          JSON.stringify({ claims: [{ predicate: "route-declared", subject: { type: "route", ref: "r1" }, qualifiers: {}, factIds: ["r1"] }] }),
        );
        return { modelTier: "sonnet" };
      }
      writeFileSync(invocation.chapter!.outputPath, "## 章\n\n覆盖率良好，未发现问题。\n");
      // Deliberately at the floor: this test is about notices not blocking, and
      // a sub-floor tier would block for an unrelated reason.
      return { modelTier: "sonnet" };
    };
    const result = await run([{ scope: "project", audience: "product" }], skipsLedger);
    const audit = JSON.parse(readFileSync(join(result.runPath, "project-product/audit.json"), "utf8"));
    const unused = audit.findings.filter((f: { code: string }) => f.code === "kind-never-used");
    expect(unused.map((f: { evidence: string }) => f.evidence).sort()).toEqual(["coverage-note", "run-context"]);
    // Not blocking: the contract directs the author to read the derived layer
    // first, so an unread raw kind is documented behaviour, not untruth.
    for (const finding of unused) expect(finding.severity).toBe("notice");
    expect(result.delivered).toBe(true);
  });
});

describe("cross-document claim consistency", () => {
  const claim = (verdict: string, at?: string) => ({
    predicate: "rule-present",
    subject: { type: "rule-subject", ref: "client-delete-guard" },
    qualifiers: at === undefined ? { verdict } : { verdict, at },
    factIds: ["r1"],
    usedBy: [],
  });

  const supporting = [
    { predicate: "coverage-recorded", subject: { type: "workspace", ref: "." }, qualifiers: {}, factIds: ["cn"] },
    { predicate: "snapshot-recorded", subject: { type: "workspace", ref: "snapshot" }, qualifiers: {}, factIds: ["rc"] },
  ];

  it("reports two targets that describe one claim differently", async () => {
    // The archived trial's real disagreement, reproduced: one target judged the
    // guard unconfirmed, the other found it. Same predicate, same subject.
    const disagreeing: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") {
        const overview = invocation.specId === "project-product";
        writeFileSync(
          invocation.claimsPath,
          JSON.stringify({ claims: [overview ? claim("unconfirmed") : claim("hit", "svc/a.go:526"), ...supporting] }),
        );
        return { modelTier: "sonnet" };
      }
      writeFileSync(invocation.chapter!.outputPath, "## 章\n");
      return { modelTier: "sonnet" };
    };
    const result = await run(
      [
        { scope: "project", audience: "product" },
        { scope: "module", audience: "product", module: "leave" },
      ],
      disagreeing,
    );
    expect(result.conflicts.map((c) => c.key).sort()).toEqual(["at", "verdict"]);
    expect(result.conflicts[0]?.between).toEqual(["project-product", "module-leaves-product"]);
    expect(result.delivered).toBe(false);
    expect(existsSync(join(result.runPath, "claim-conflicts.json"))).toBe(true);
  });

  it("reports nothing when the two targets agree", async () => {
    const agreeing: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") {
        writeFileSync(invocation.claimsPath, JSON.stringify({ claims: [claim("hit", "svc/a.go:526"), ...supporting] }));
        return { modelTier: "sonnet" };
      }
      writeFileSync(invocation.chapter!.outputPath, "## 章\n");
      return { modelTier: "sonnet" };
    };
    const result = await run(
      [
        { scope: "project", audience: "product" },
        { scope: "module", audience: "product", module: "leave" },
      ],
      agreeing,
    );
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(result.runPath, "claim-conflicts.json"))).toBe(false);
  });
});

describe("progress events", () => {
  it("reads a tool call out of the stream, naming what it acts on", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "packs/project/index.json" } }] },
    });
    expect(progressFrom(line, 1500)).toEqual({
      elapsedMs: 1500,
      kind: "tool",
      detail: "Read packs/project/index.json",
    });
  });

  it("reports the start and the end", () => {
    expect(progressFrom(JSON.stringify({ type: "system", subtype: "init" }), 0)?.kind).toBe("start");
    expect(progressFrom(JSON.stringify({ type: "result" }), 9)?.kind).toBe("done");
  });

  it("reports reasoning, so a long think is not silence", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking" }] } });
    expect(progressFrom(line, 5)?.kind).toBe("thinking");
  });

  it("ignores a line it cannot read rather than failing the run", () => {
    expect(progressFrom("not json", 0)).toBeNull();
    expect(progressFrom(JSON.stringify({ type: "unknown" }), 0)).toBeNull();
  });

  it("names a tool with no obvious subject by its name alone", () => {
    const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } });
    expect(progressFrom(line, 0)?.detail).toBe("Bash");
  });
});

describe("the tier floor", () => {
  it("refuses a sub-floor run as a deliverable, however clean its audit", async () => {
    // The failure below the floor is fabrication, not lower quality, and a
    // fabricated report is exactly the one that looks fine.
    const lowTier: SkillRunner = async (invocation) => {
      const outcome = await goodRunner(invocation);
      return { ...outcome, modelTier: "haiku" };
    };
    const result = await run([{ scope: "project", audience: "product" }], lowTier);
    expect(result.outcomes[0]?.record.auditPassed).toBe(true);
    expect(result.belowTierFloor).toBe(true);
    expect(result.delivered).toBe(false);
    expect(explainRun(result)).toContain("floor");
  });

  it("accepts the host's own choice of model", async () => {
    const hostDefault: SkillRunner = async (invocation) => {
      const outcome = await goodRunner(invocation);
      return { ...outcome, modelTier: "default" };
    };
    const result = await run([{ scope: "project", audience: "product" }], hostDefault);
    expect(result.belowTierFloor).toBe(false);
    expect(result.delivered).toBe(true);
  });
});

describe("surviving an interruption", () => {
  it("reads the session id from any stream line, so a drop can be continued", () => {
    // A drop at minute twenty of a twenty-one-minute call cost $9 and all
    // twenty minutes, because there was nothing to resume from.
    const line = JSON.stringify({ type: "stream_event", session_id: "22d96b19-b9e1-4f88" });
    expect(sessionIdFrom(line)).toBe("22d96b19-b9e1-4f88");
    expect(sessionIdFrom("not json")).toBeNull();
    expect(sessionIdFrom(JSON.stringify({ type: "system" }))).toBeNull();
  });

  it("finds the reason in the stream's own result event, not in stderr", () => {
    // stderr came back empty on a quota exhaustion, so `exit 1` was all the
    // caller was told about a stop it needed to understand.
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: "You've hit your session limit · resets 10:40pm (Asia/Shanghai)",
    });
    expect(failureReasonFrom(line)).toContain("session limit");
    expect(failureReasonFrom(JSON.stringify({ type: "result", is_error: false, result: "fine" }))).toBeNull();
    expect(failureReasonFrom("garbage")).toBeNull();
  });

  it("separates a spent budget from a flaky connection", () => {
    const quota = "You've hit your session limit · resets 10:40pm (Asia/Shanghai)";
    const dropped = "API Error: Connection closed mid-response.";
    expect(isQuotaExhausted(quota)).toBe(true);
    expect(isQuotaExhausted(dropped)).toBe(false);
    // Retrying a spent window in five seconds cannot help; retrying a drop can.
    expect(isTransientFailure(quota)).toBe(false);
    expect(isTransientFailure(dropped)).toBe(true);
  });

  it("keeps the stated reset time, so the caller can say when to resume", () => {
    expect(quotaResetFrom("You've hit your session limit · resets 10:40pm (Asia/Shanghai)")).toBe(
      "resets 10:40pm (Asia/Shanghai)".replace("resets ", ""),
    );
    expect(quotaResetFrom("something else")).toBeNull();
  });
});

describe("resuming a run", () => {
  it("keeps a claim set that already exists rather than paying for it again", async () => {
    const first = await run([{ scope: "project", audience: "product" }], goodRunner);
    let claimsPasses = 0;
    const counting: SkillRunner = async (invocation) => {
      if (invocation.phase === "claims") claimsPasses += 1;
      return goodRunner(invocation);
    };
    await generateReports({
      plan: plan([{ scope: "project", audience: "product" }]),
      store,
      snapshotId,
      snapshotIdentity: "run-1",
      outputRoot: join(first.runPath, ".."),
      repoRoot: process.cwd(),
      instant: INSTANT,
      runSkill: counting,
      membership: new Map(),
      resumeRunId: first.runId,
    });
    // The claims pass is the most expensive call in the run, and redoing it
    // would also change the claims the finished chapters were written against.
    expect(claimsPasses).toBe(0);
  });

  it("writes only the chapters that are missing", async () => {
    const first = await run([{ scope: "project", audience: "product" }], goodRunner);
    // Drop one chapter and resume; only that one should be authored again.
    const chapters = join(first.runPath, "project-product/chapters");
    const dropped = readdirSync(chapters).filter((name) => name.endsWith(".md"))[0]!;
    rmSync(join(chapters, dropped));
    let written = 0;
    const counting: SkillRunner = async (invocation) => {
      if (invocation.phase === "chapter") written += 1;
      return goodRunner(invocation);
    };

    const resumed = await generateReports({
      plan: plan([{ scope: "project", audience: "product" }]),
      store,
      snapshotId,
      snapshotIdentity: "run-1",
      outputRoot: join(first.runPath, ".."),
      repoRoot: process.cwd(),
      instant: INSTANT,
      runSkill: counting,
      membership: new Map(),
      resumeRunId: first.runId,
    });
    // A resumed run re-cuts the pack; leaving the old database in place made
    // creating its schema fail and took the whole target down.
    expect(resumed.outcomes[0]?.blocked).toBeNull();
    expect(written).toBe(1);
    expect(resumed.runId).toBe(first.runId);
    expect(existsSync(join(chapters, dropped))).toBe(true);
  });

  it("refuses to resume a run that does not exist", async () => {
    await expect(
      generateReports({
        plan: plan([{ scope: "project", audience: "product" }]),
        store,
        snapshotId,
        snapshotIdentity: "run-1",
        outputRoot: mkdtempSync(join(tmpdir(), "runs-")),
        repoRoot: process.cwd(),
        instant: INSTANT,
        runSkill: goodRunner,
        membership: new Map(),
        resumeRunId: "08-03_00-00_nothing",
      }),
    ).rejects.toThrow(/no run to resume/);
  });
});

describe("one target at a time", () => {
  it("stops after a spent budget instead of emptying the remaining targets", async () => {
    let started = 0;
    const exhausting: SkillRunner = async () => {
      started += 1;
      throw new Error("quota exhausted while authoring x; resume this run after 10:40pm");
    };
    const result = await generateReports({
      plan: plan([
        { scope: "project", audience: "product" },
        { scope: "module", audience: "product", module: "leave" },
      ]),
      store,
      snapshotId,
      snapshotIdentity: "run-1",
      outputRoot: mkdtempSync(join(tmpdir(), "runs-")),
      repoRoot: process.cwd(),
      instant: INSTANT,
      runSkill: exhausting,
      membership: new Map([["mod_a", { files: new Set(["svc/a.go"]), subjectKeys: new Set(["mod_a"]) }]]),
      targetConcurrency: 1,
    });
    // The budget will not refill within this run; continuing would only produce
    // a second empty directory.
    expect(started).toBe(1);
    expect(result.outcomes).toHaveLength(1);
  });

  it("runs one at a time when asked, so a window finishes the first target", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow: SkillRunner = async (invocation) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return goodRunner(invocation);
    };
    await generateReports({
      plan: plan([
        { scope: "project", audience: "product" },
        { scope: "module", audience: "product", module: "leave" },
      ]),
      store,
      snapshotId,
      snapshotIdentity: "run-1",
      outputRoot: mkdtempSync(join(tmpdir(), "runs-")),
      repoRoot: process.cwd(),
      instant: INSTANT,
      runSkill: slow,
      membership: new Map([["mod_a", { files: new Set(["svc/a.go"]), subjectKeys: new Set(["mod_a"]) }]]),
      targetConcurrency: 1,
      chapterConcurrency: 1,
    });
    expect(peak).toBe(1);
  });
});
