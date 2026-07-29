import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogicProvider } from "../../engine/providers/logic/provider.js";
import type { ConditionRecord, DiscardedErrorRecord } from "../../engine/structural/rules.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  const contribution = createLogicProvider().extract({
    name: "svc",
    path: workDir,
    analyzedFiles: files,
  });
  return {
    conditions: contribution.records.condition as readonly ConditionRecord[],
    discarded: contribution.records["discarded-error"] as readonly DiscardedErrorRecord[],
    failures: contribution.failures,
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-logic-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("conditions", () => {
  it("records a threshold with its subject, operator and value", () => {
    write(
      "svc.go",
      `package svc
func Approve(r Request) error {
	if r.Hours > 16 {
		return escalate()
	}
	return nil
}
`,
    );

    const { conditions } = extract(["svc.go"]);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toMatchObject({
      subject: "r.Hours",
      operator: ">",
      literal: 16,
      literalKind: "numeric",
      enclosingFunction: "Approve",
    });
    expect(conditions[0]!.source.startLine).toBe(3);
  });

  it("reads a rule written with the value first the same way as value last", () => {
    // `16 < hours` and `hours > 16` are one rule; recorded differently they
    // would never be seen to agree or disagree.
    write("a.go", "package a\nfunc F(hours int) bool { return 16 < hours }\n");
    write("b.go", "package b\nfunc F(hours int) bool { return hours > 16 }\n");

    const { conditions } = extract(["a.go", "b.go"]);
    expect(
      conditions.map((condition) => `${condition.subject} ${condition.operator} ${condition.literal}`),
    ).toEqual(["hours > 16", "hours > 16"]);
  });

  it("records a string comparison", () => {
    write("svc.ts", "export const f = (kind: string) => kind === 'sick';\n");
    const { conditions } = extract(["svc.ts"]);
    expect(conditions[0]).toMatchObject({ subject: "kind", literal: "sick", literalKind: "string" });
  });

  it("leaves out counters and bounds checks, which are not business rules", () => {
    write(
      "loop.go",
      `package loop
func F(items []int) {
	for i := 0; i < 10; i++ {
	}
	if len(items) > 0 {
	}
	if retries < 3 {
	}
}
`,
    );

    expect(extract(["loop.go"]).conditions).toEqual([]);
  });

  it("leaves out a comparison whose subject is an expression rather than a name", () => {
    write("x.go", "package x\nfunc F() bool { return compute() > 5 }\n");
    expect(extract(["x.go"]).conditions).toEqual([]);
  });

  it("leaves out a comparison between two names, which states no value", () => {
    write("y.go", "package y\nfunc F(a int, b int) bool { return a > b }\n");
    expect(extract(["y.go"]).conditions).toEqual([]);
  });

  it("does not read test files, whose conditions are assertions", () => {
    write("svc_test.go", "package svc\nfunc TestX(t *testing.T) { if x.Hours > 16 {} }\n");
    expect(extract(["svc_test.go"]).conditions).toEqual([]);
  });
});

describe("discarded errors", () => {
  it("records a method dispatched as a goroutine, which can return nothing to anyone", () => {
    write("svc.go", "package svc\nfunc F(c Ctx) {\n\tgo notifier.Execute(c)\n}\n");

    const { discarded } = extract(["svc.go"]);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({ mechanism: "goroutine", enclosingFunction: "F" });
    expect(discarded[0]!.call).toContain("notifier.Execute");
  });

  it("leaves an anonymous goroutine alone, since it can handle its own result", () => {
    write("svc.go", "package svc\nfunc F() {\n\tgo func() { if err := run(); err != nil { log(err) } }()\n}\n");
    expect(extract(["svc.go"]).discarded).toEqual([]);
  });

  it("records an un-awaited call to a method the file awaits elsewhere", () => {
    write(
      "svc.js",
      `async function save(a, b) {
  await a.save();
  b.save();
}
`,
    );

    const { discarded } = extract(["svc.js"]);
    expect(discarded).toHaveLength(1);
    expect(discarded[0]!.call).toContain("b.save()");
  });

  it("leaves alone a call the file never awaits, which is likely synchronous", () => {
    write("svc.js", "function f(res) {\n  res.json({ ok: true });\n}\n");
    expect(extract(["svc.js"]).discarded).toEqual([]);
  });

  it("leaves alone a call whose result is handled", () => {
    write(
      "svc.js",
      "async function f(a, b) {\n  await a.save();\n  b.save().catch(report);\n}\n",
    );
    expect(extract(["svc.js"]).discarded).toEqual([]);
  });
});

describe("accounting", () => {
  it("records a file it cannot read rather than skipping it silently", () => {
    write("good.go", "package good\nfunc F(hours int) bool { return hours > 5 }\n");
    const { conditions, failures } = extract(["good.go", "missing.go"]);

    expect(conditions).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.scope).toBe("missing.go");
  });

  it("does not read a language it has no grammar for, and says nothing about it", () => {
    write("main.py", "if hours > 16:\n    pass\n");
    const { conditions, failures } = extract(["main.py"]);
    expect(conditions).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe("what a guard does when it fires", () => {
  it("reads a Go branch that returns as one that rejects", () => {
    // Go nests a block's statements one level deeper than the script
    // grammars do. Reading only the block's direct children found no return
    // in any Go branch, so every guard in the language this tool was built
    // against was published as one that carries on.
    write(
      "svc.go",
      `package svc
func Approve(r Request) error {
	if r.Hours > 40 {
		return errors.New("too many")
	}
	return nil
}
`,
    );
    const { conditions } = extract(["svc.go"]);
    expect(conditions[0]!.guarded).toBe("rejects");
  });

  it("reads a Go branch that falls through as one that continues", () => {
    write(
      "svc.go",
      `package svc
func Approve(r Request) {
	if r.Hours > 40 {
		r.Flag = true
	}
	save(r)
}
`,
    );
    const { conditions } = extract(["svc.go"]);
    expect(conditions[0]!.guarded).toBe("continues");
  });

  it("reads a TypeScript branch that throws as one that rejects", () => {
    write(
      "svc.ts",
      `export function approve(hours: number): void {
  if (hours > 40) {
    throw new Error("too many");
  }
  save(hours);
}
`,
    );
    const { conditions } = extract(["svc.ts"]);
    expect(conditions[0]!.guarded).toBe("rejects");
  });

  it("credits a nested function's return to that function, not to the branch", () => {
    write(
      "svc.ts",
      `export function approve(hours: number): void {
  if (hours > 40) {
    schedule(() => { return 1; });
  }
  save(hours);
}
`,
    );
    const { conditions } = extract(["svc.ts"]);
    expect(conditions[0]!.guarded).toBe("continues");
  });
});
