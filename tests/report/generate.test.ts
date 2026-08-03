import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openStore } from "../../engine/store/open.js";
import type { Store } from "../../engine/store/types.js";
import { loadSpecRegistry } from "../../engine/contracts/report/specs.js";
import type { ModuleDirectory } from "../../engine/contracts/module/index.js";
import { generateReports, explainRun } from "../../engine/report/generate.js";
import { planReport } from "../../engine/report/orchestrate.js";
import { buildSkillPrompt, progressFrom, type SkillRunner } from "../../engine/report/skill-port.js";

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
    expect(manifest.targets[0].specVersion).toBe("1.0.0");
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
      claimsPath: "/c.json", viewPath: "/v.md", repoRoot: "/repo",
    });
    for (const line of ["packPath: /p/index.json", "specId: project-product", "language: zh-CN"]) {
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
        return { modelTier: "haiku" };
      }
      writeFileSync(invocation.chapter!.outputPath, "## 章\n\n覆盖率良好，未发现问题。\n");
      return { modelTier: "haiku" };
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
