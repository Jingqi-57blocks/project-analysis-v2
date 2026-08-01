import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { declared, lineRef } from "../../engine/structural/provenance.js";
import type { ConditionRecord } from "../../engine/structural/rules.js";
import type { RootFacts } from "../../engine/kb/extract.js";
import type { ValueSet } from "../../engine/semantics/enums.js";
import {
  eligibleStateSets,
  observeChangesInFile,
  observeStateChanges,
} from "../../engine/kb/state-transition-observe.js";

// A Go-shaped status vocabulary — iota-numbered members, named after its type,
// exactly what `valueSetsIn` extracts from a `const` block.
const lvStatus: ValueSet = {
  name: "LvStatusC",
  rootName: "svc",
  relPath: "internal/constant/leave.go",
  startLine: 96,
  members: [
    { name: "LvWaitingL1ApproveC", value: 1 },
    { name: "LvWaitingL2ApproveC", value: 2 },
    { name: "LvWaitingL3ApproveC", value: 3 },
    { name: "LvApprovedC", value: 4 },
  ],
};

function condition(subject: string, literal: number | string, root = "svc"): ConditionRecord {
  return {
    rootName: root,
    subject,
    operator: "==",
    literal,
    literalKind: typeof literal === "number" ? "numeric" : "string",
    text: `${subject} == ${literal}`,
    enclosingFunction: "Approve",
    guarded: "rejects",
    source: lineRef(root, "service.go", 10),
    provenance: declared(lineRef(root, "service.go", 10)),
  };
}

describe("eligibleStateSets", () => {
  it("promotes a set only when a comparison resolves to one of its members", () => {
    const eligible = eligibleStateSets([lvStatus], [condition("lv.Status", 4)]);
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.name).toBe("LvStatusC");
  });

  it("leaves a value set nothing compares against out — no status/state whitelist", () => {
    // The word "Status" is in the name, but no condition resolves to a member, so
    // it is a plain vocabulary, not a state machine.
    expect(eligibleStateSets([lvStatus], [])).toHaveLength(0);
    expect(eligibleStateSets([lvStatus], [condition("lv.Status", 999)])).toHaveLength(0);
  });
});

describe("observeChangesInFile — Go write contexts", () => {
  // Genuine writes: an assignment RHS, a `:=` RHS, a struct-literal keyed value and
  // a keyed value of an update map (`Updates(map{"status": M})` — the cron TR-11
  // shape). Bare call arguments are reads (see the block below).
  const source = `package leave

func Approve(tx *gorm.DB, lv *Leave) {
	leave.Status = constant.LvApprovedC.Uint8()
	nextStatus := constant.LvWaitingL1ApproveC
	tx.Model(lv).Updates(map[string]interface{}{"status": constant.LvWaitingL2ApproveC.Uint8()})
	_ = model.Leave{Status: constant.LvWaitingL3ApproveC.Uint8()}
	_ = nextStatus
}
`;

  const changes = observeChangesInFile("svc", "service.go", source, [lvStatus]);

  it("keeps an assignment right-hand side (X.Status = M)", () => {
    const c = changes.find((o) => o.toValue === 4)!;
    expect(c).toBeDefined();
    expect(c.field).toBe("LvStatusC");
    expect(c.fromValue).toBeNull();
    expect(c.trigger).toBe("Approve");
    expect(c.source.relPath).toBe("service.go");
  });

  it("keeps a short-var declaration right-hand side (nextStatus := M)", () => {
    expect(changes.some((o) => o.toValue === 1)).toBe(true);
  });

  it("keeps an update-map keyed value (Updates(map{\"status\": M})) — the cron write shape", () => {
    expect(changes.some((o) => o.toValue === 2)).toBe(true);
  });

  it("keeps a struct-literal keyed value (model.Leave{Status: M})", () => {
    expect(changes.some((o) => o.toValue === 3)).toBe(true);
  });

  it("emits every genuine write as a to-only observation of its set, and nothing else", () => {
    expect(changes.map((o) => o.toValue).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4]);
    expect(changes.every((o) => o.field === "LvStatusC" && o.fromValue === null && o.guard === null)).toBe(true);
  });
});

describe("observeChangesInFile — Go read contexts are rejected", () => {
  it("does not observe a comparison operand (if x.Status == M)", () => {
    const source = `package leave
func Check(lv *Leave) {
	if lv.Status == constant.LvApprovedC.Uint8() {
		return
	}
}
`;
    expect(observeChangesInFile("svc", "service.go", source, [lvStatus])).toEqual([]);
  });

  it("does not observe a bare call argument (updateLvStatus(tx, id, M.Uint8()))", () => {
    // A member handed to a call is as often read as written; a to-only transition
    // asserted from it would be a false fact.
    const source = `package leave
func Approve(tx *gorm.DB, lv *Leave) {
	updateLvStatus(tx, lv.ID, constant.LvWaitingL2ApproveC.Uint8())
}
`;
    expect(observeChangesInFile("svc", "service.go", source, [lvStatus])).toEqual([]);
  });

  it("does not observe a query filter argument (Where(\"status = ?\", M))", () => {
    const source = `package leave
func List(tx *gorm.DB) {
	tx.Where("status = ?", constant.LvApprovedC.Uint8()).Find(&rows)
}
`;
    expect(observeChangesInFile("svc", "service.go", source, [lvStatus])).toEqual([]);
  });

  it("does not observe a format argument (Sprintf(\"%d\", M.Uint8()))", () => {
    const source = `package leave
func Label() string {
	return fmt.Sprintf("%d", constant.LvApprovedC.Uint8())
}
`;
    expect(observeChangesInFile("svc", "service.go", source, [lvStatus])).toEqual([]);
  });

  it("does not observe a membership-test argument (funk.Contains(list, M))", () => {
    const source = `package leave
func Has(list []uint8) bool {
	return funk.Contains(list, constant.LvApprovedC.Uint8())
}
`;
    expect(observeChangesInFile("svc", "service.go", source, [lvStatus])).toEqual([]);
  });

  it("does not observe an element of an unkeyed slice literal ([]uint8{M, ...})", () => {
    const source = `package constant
var InProgress = []uint8{LvWaitingL1ApproveC, LvWaitingL2ApproveC, LvApprovedC}
`;
    // A membership list is vocabulary, not a change into any of its members.
    expect(observeChangesInFile("svc", "internal/constant/leave.go", source, [lvStatus])).toEqual([]);
  });

  it("does not observe a keyed composite-literal key (M: F)", () => {
    const source = `package constant
var m = map[LvStatusC]string{LvApprovedC: "Approved"}
`;
    expect(observeChangesInFile("svc", "internal/constant/leave.go", source, [lvStatus])).toEqual([]);
  });
});

describe("observeChangesInFile — a second, angels-shaped target (TS enum)", () => {
  // A string-valued TS enum with a `===` comparison as the eligibility evidence and
  // a field assignment as the write — the generic mechanism, a different language.
  const orderStatus: ValueSet = {
    name: "OrderStatus",
    rootName: "web",
    relPath: "src/order.ts",
    startLine: 1,
    members: [
      { name: "Processing", value: "processing" },
      { name: "Delivered", value: "delivered" },
      { name: "Cancelled", value: "cancelled" },
    ],
  };

  it("is eligible from a `===` comparison and observes the field assignment", () => {
    const eligible = eligibleStateSets([orderStatus], [condition("o.status", "processing", "web")]);
    expect(eligible).toHaveLength(1);

    const source = `function deliver(o: Order) {
  if (o.status === OrderStatus.Processing) { return; }
  o.status = OrderStatus.Delivered;
}
`;
    const changes = observeChangesInFile("web", "src/order.ts", source, eligible);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe("OrderStatus");
    expect(changes[0]!.toValue).toBe("delivered");
    expect(changes[0]!.trigger).toBe("deliver");
    expect(changes[0]!.fromValue).toBeNull();
  });

  it("does not observe a JS membership-test argument (list.includes(M))", () => {
    const eligible = eligibleStateSets([orderStatus], [condition("o.status", "processing", "web")]);
    const source = `function isTerminal(o: Order, done: string[]) {
  return done.includes(OrderStatus.Delivered);
}
`;
    expect(observeChangesInFile("web", "src/order.ts", source, eligible)).toEqual([]);
  });
});

describe("observeStateChanges — over roots, failing open", () => {
  function rootWith(rootName: string, analyzedFiles: readonly string[]): RootFacts {
    // Only rootName and analyzedFiles are read by the observer.
    return { rootName, analyzedFiles } as unknown as RootFacts;
  }

  it("reads a root's files and yields deterministic, deduped observations", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi83-"));
    writeFileSync(
      join(dir, "service.go"),
      `package leave
func Approve(lv *Leave) {
	leave.Status = constant.LvApprovedC.Uint8()
}
`,
    );

    const result = observeStateChanges({
      roots: [rootWith("svc", ["service.go"])],
      valueSets: [lvStatus],
      conditions: [condition("lv.Status", 4)],
      rootPaths: new Map([["svc", dir]]),
    });
    expect(result.notes).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.toValue).toBe(4);
  });

  it("notes a missing root path instead of throwing", () => {
    const result = observeStateChanges({
      roots: [rootWith("svc", ["service.go"])],
      valueSets: [lvStatus],
      conditions: [condition("lv.Status", 4)],
      rootPaths: new Map(),
    });
    expect(result.changes).toEqual([]);
    expect(result.notes.join()).toContain("no path for root svc");
  });

  it("scans nothing when no set is state-bearing", () => {
    const result = observeStateChanges({
      roots: [rootWith("svc", ["service.go"])],
      valueSets: [lvStatus],
      conditions: [],
      rootPaths: new Map([["svc", "/nonexistent"]]),
    });
    expect(result).toEqual({ changes: [], notes: [] });
  });
});
