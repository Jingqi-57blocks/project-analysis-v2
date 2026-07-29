import { describe, expect, it } from "vitest";

import { decisionsIn, MAX_BRANCHES } from "../../engine/providers/logic/decisions.js";

const GO = `package svc

func Apply(lv Leave) error {
	switch lv.Type {
	case BTO:
		db.Table("bto").Create(&lv)
		return nil
	case PTO:
		if lv.Hours > 40 {
			return errTooMany
		}
		db.Table("pto").Create(&lv)
	default:
		return errUnknown
	}
	return nil
}

func Check(lv Leave) error {
	if lv.Hours > 16 {
		return errA
	} else if lv.Hours > 8 {
		notify(lv)
	} else {
		db.Table("small").Create(&lv)
	}
	return nil
}
`;

const TS = `export function apply(lv: Leave) {
  switch (lv.type) {
    case "BTO": { save(lv); return; }
    case "PTO":
      if (lv.hours > 40) throw new Error("too many");
      save(lv);
      break;
    default:
      throw new Error("unknown");
  }
}

export function check(lv: Leave) {
  if (lv.hours > 16) {
    return reject();
  } else if (lv.hours > 8) {
    notify(lv);
  } else {
    save(lv);
  }
}
`;

describe("a switch is one decision, not several comparisons", () => {
  it("reads every case and the default as branches of one decision", () => {
    const decision = decisionsIn("svc", "leave.go", GO).find((entry) => entry.kind === "switch")!;
    expect(decision.subject).toBe("lv.Type");
    expect(decision.branches.map((branch) => branch.test)).toEqual(["BTO", "PTO", "otherwise"]);
  });

  it("names the value each branch tests, so a value set can explain it", () => {
    // `2` means nothing; `PTO` is what the project calls it.
    const decision = decisionsIn("svc", "leave.go", GO).find((entry) => entry.kind === "switch")!;
    expect(decision.branches[0]!.values).toContain("BTO");
  });

  it("says which branches leave and which carry on", () => {
    const decision = decisionsIn("svc", "leave.go", GO).find((entry) => entry.kind === "switch")!;
    expect(decision.branches.map((branch) => branch.outcome)).toEqual([
      "leaves",
      "continues",
      "leaves",
    ]);
  });

  it("reads the same shape in TypeScript", () => {
    const decision = decisionsIn("ui", "leave.ts", TS).find((entry) => entry.kind === "switch")!;
    expect(decision.subject).toBe("lv.type");
    expect(decision.branches.map((branch) => branch.test)).toEqual(["BTO", "PTO", "otherwise"]);
  });
});

describe("an if chain is one decision too", () => {
  it("keeps the whole chain together rather than nesting each else", () => {
    // Read as nested statements this is three decisions; a reader sees one
    // question with three answers.
    const decision = decisionsIn("svc", "leave.go", GO).find(
      (entry) => entry.enclosingFunction === "Check",
    )!;
    expect(decision.branches).toHaveLength(3);
    expect(decision.branches[2]!.test).toBe("otherwise");
  });

  it("names what the chain is about when its branches agree", () => {
    const decision = decisionsIn("svc", "leave.go", GO).find(
      (entry) => entry.enclosingFunction === "Check",
    )!;
    expect(decision.subject).toBe("lv.Hours");
  });

  it("leaves the subject empty when the branches test different things", () => {
    // Naming one of them would say the decision is about something it is not.
    const source = `package svc
func F(a A) {
	if a.X > 1 {
		one()
	} else if a.Y == 2 {
		two()
	}
}
`;
    expect(decisionsIn("svc", "f.go", source)[0]!.subject).toBe("");
  });

  it("reads the same chain in TypeScript", () => {
    const decision = decisionsIn("ui", "leave.ts", TS).find(
      (entry) => entry.enclosingFunction === "check",
    )!;
    expect(decision.branches).toHaveLength(3);
    expect(decision.branches[0]!.outcome).toBe("leaves");
  });
});

describe("nesting", () => {
  it("records a decision made inside a branch", () => {
    // `if type == PTO { if hours > 40 { reject } }` is where the rule someone
    // actually needs usually lives.
    const decision = decisionsIn("svc", "leave.go", GO).find((entry) => entry.kind === "switch")!;
    const pto = decision.branches[1]!;
    expect(pto.decisions).toHaveLength(1);
    expect(pto.decisions[0]!.branches[0]!.test).toBe("lv.Hours > 40");
  });

  it("says it truncated rather than silently stopping", () => {
    const deep = Array.from({ length: 12 }, (_, n) => `if x > ${n} {`).join("\n") +
      "\ndo()\n" +
      "}".repeat(12);
    const source = `package svc\nfunc F(x int) {\n${deep}\n}\n`;
    const decisions = decisionsIn("svc", "deep.go", source);
    // A single-branch chain is a guard, which conditions already cover — but
    // a truncation must never pass unrecorded where trees are produced.
    const wide = `package svc
func F(x int) {
	switch x {
${Array.from({ length: MAX_BRANCHES + 5 }, (_, n) => `\tcase ${n}:\n\t\tdo${n}()`).join("\n")}
	}
}
`;
    const truncated = decisionsIn("svc", "wide.go", wide)[0]!;
    expect(truncated.branches.length).toBeLessThanOrEqual(MAX_BRANCHES);
    expect(truncated.truncated).toBe(true);
    expect(decisions.every((entry) => entry.branches.length > 1)).toBe(true);
  });
});

describe("what it does not record", () => {
  it("leaves a single guard to the condition records", () => {
    // One `if` with no else is a guard, and `condition` already states it
    // with its subject, value and whether it rejects.
    const source = `package svc
func F(x int) error {
	if x > 40 {
		return err
	}
	return nil
}
`;
    expect(decisionsIn("svc", "guard.go", source)).toEqual([]);
  });

  it("records where a branch is rather than what it does", () => {
    // Tables and calls have readers of their own; detecting them again here
    // would be a second opinion that can disagree with the first.
    const decision = decisionsIn("svc", "leave.go", GO).find((entry) => entry.kind === "switch")!;
    const branch = decision.branches[0]!;
    expect(branch.startLine).toBeGreaterThan(0);
    expect(branch.endLine).toBeGreaterThanOrEqual(branch.startLine);
    expect(Object.keys(branch)).not.toContain("tables");
  });

  it("says nothing about a language it has no grammar for", () => {
    expect(decisionsIn("svc", "main.py", "if x > 1:\n    pass\nelse:\n    pass\n")).toEqual([]);
  });
});
