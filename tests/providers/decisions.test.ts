import { describe, expect, it } from "vitest";

import { decisionsIn, MAX_BRANCHES, MAX_DEPTH } from "../../engine/providers/logic/decisions.js";

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

/** A switch with more cases than the breadth bound allows. */
function wideSwitch(name: string): string {
  const cases = Array.from(
    { length: MAX_BRANCHES + 5 },
    (_, n) => `\tcase ${n}:\n\t\tdo${n}()`,
  ).join("\n");
  return `func ${name}(x int) {\n\tswitch x {\n${cases}\n\t}\n}\n`;
}

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

  it("names the cases of a Go type switch, which names them differently", () => {
    const source = `package svc
func F(v any) {
	switch v.(type) {
	case *Leave:
		a()
	case *Holiday:
		b()
	default:
		c()
	}
}
`;
    const branches = decisionsIn("svc", "f.go", source)[0]!.branches;
    expect(branches.map((branch) => branch.test)).toEqual(["*Leave", "*Holiday", "otherwise"]);
  });

  it("keeps every value of a case that lists several", () => {
    const source = `package svc
func F(s string) {
	switch s {
	case "a", "b":
		one()
	default:
		two()
	}
}
`;
    expect(decisionsIn("svc", "f.go", source)[0]!.branches[0]!.values).toEqual(["a", "b"]);
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

  it("names the subject in TypeScript, whose test carries parentheses", () => {
    // `(u.role === "admin")` never matched a pattern anchored at the start,
    // so no if-chain in either script language ever produced a subject.
    const source = `export function f(u: User) {
  if (u.role === "admin") { a(); } else if (u.role === "guest") { b(); } else { c(); }
}
`;
    expect(decisionsIn("ui", "f.ts", source)[0]!.subject).toBe("u.role");
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

  it("refuses a subject when a branch's test cannot be read at all", () => {
    // Dropping unreadable branches before checking agreement let a minority
    // name the decision — two branches about something else, titled by one.
    const source = `package svc
func F(x int, y Y) {
	if x == 1 {
		a()
	} else if isReady(y) {
		b()
	} else {
		c()
	}
}
`;
    expect(decisionsIn("svc", "f.go", source)[0]!.subject).toBe("");
  });

  it("keeps the statement that bound the name a Go branch tests", () => {
    // The condition alone is `ok`, which names nothing a reader has seen.
    const source = `package svc
func F(m map[string]Leave) {
	if lv, ok := m["a"]; ok {
		use(lv)
	} else {
		other()
	}
}
`;
    expect(decisionsIn("svc", "f.go", source)[0]!.branches[0]!.test).toBe(
      `lv, ok := m["a"]; ok`,
    );
  });

  it("reads the same chain in TypeScript", () => {
    const decision = decisionsIn("ui", "leave.ts", TS).find(
      (entry) => entry.enclosingFunction === "check",
    )!;
    expect(decision.branches).toHaveLength(3);
    expect(decision.branches[0]!.outcome).toBe("leaves");
  });

  it("reads a branch with no braces as one that leaves", () => {
    // `if (!ok) return;` is among the commonest shapes there is, and the body
    // node is the return itself rather than a block containing one.
    const source = `export function f(x: number) {
  if (x > 1) return "a";
  else if (x > 0) throw new Error("b");
  else return "c";
}
`;
    const decision = decisionsIn("ui", "f.ts", source)[0]!;
    expect(decision.branches.map((branch) => branch.outcome)).toEqual([
      "leaves",
      "leaves",
      "leaves",
    ]);
  });

  it("does not lose statements that follow a nested block", () => {
    // Following the first block-shaped child abandoned every sibling, so a
    // bare block hid the return after it — and any decision after it too.
    const source = `package svc
func F(x int) error {
	if x > 1 {
		log()
		{
			tmp := 1
			_ = tmp
		}
		return errA
	} else {
		return errB
	}
}
`;
    expect(decisionsIn("svc", "f.go", source)[0]!.branches[0]!.outcome).toBe("leaves");
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

  it("says it truncated rather than silently narrowing", () => {
    const truncated = decisionsIn("svc", "wide.go", `package svc\n${wideSwitch("F")}`)[0]!;
    expect(truncated.branches.length).toBeLessThanOrEqual(MAX_BRANCHES);
    expect(truncated.truncated).toBe(true);
  });

  it("stops descending at the depth bound, and says so", () => {
    // Nothing exercised the depth bound before: the fixture was single
    // guards, which are not decisions, so the assertion ran over an empty
    // array and was true of nothing.
    const nest = (depth: number): string =>
      depth === 0
        ? "\t\tdo()"
        : `\t\tif x > ${depth} {\n${nest(depth - 1)}\n\t\t} else {\n\t\t\tother()\n\t\t}`;
    const source = `package svc\nfunc F(x int) {\n${nest(MAX_DEPTH + 3)}\n}\n`;

    let level = decisionsIn("svc", "deep.go", source)[0]!;
    let depth = 1;
    while (level.branches.some((branch) => branch.decisions.length > 0)) {
      level = level.branches.flatMap((branch) => branch.decisions)[0]!;
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH + 1);
    expect(level.truncated).toBe(true);
  });

  it("does not disclaim a complete decision because another in the file was cut", () => {
    // One flag shared across the file marked every decision in it partial,
    // including the ones that were whole.
    const source = `package svc\n${wideSwitch("Wide")}
func Small(y int) {
	if y > 1 {
		a()
	} else {
		b()
	}
}
`;
    const small = decisionsIn("svc", "both.go", source).find(
      (entry) => entry.enclosingFunction === "Small",
    )!;
    expect(small.branches).toHaveLength(2);
    expect(small.truncated).toBe(false);
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

  it("does not take a call's name, or the subject itself, as a value", () => {
    const source = `package svc
func F(lv Leave) {
	if isValid(lv.Owner, threshold) {
		a()
	} else {
		b()
	}
}
`;
    expect(decisionsIn("svc", "f.go", source)[0]!.branches[0]!.values).toEqual([]);
  });

  it("counts a string value once", () => {
    const source = `package svc
func F(s string) {
	switch s {
	case "a":
		one()
	default:
		two()
	}
}
`;
    expect(decisionsIn("svc", "f.go", source)[0]!.branches[0]!.values).toEqual(["a"]);
  });

  it("says nothing about a language it has no grammar for", () => {
    expect(decisionsIn("svc", "main.py", "if x > 1:\n    pass\nelse:\n    pass\n")).toEqual([]);
  });
});
