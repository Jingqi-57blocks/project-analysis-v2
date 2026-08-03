import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolved, lineRef } from "../../engine/structural/provenance.js";
import { parseSource } from "../../engine/text/ast.js";
import { guardsIn } from "../../engine/providers/logic/provider.js";
import type { GuardRecord } from "../../engine/structural/rules.js";
import type { RootFacts } from "../../engine/kb/extract.js";
import type { ValueSet } from "../../engine/semantics/enums.js";
import {
  observeAuthInFile,
  observeAuthorization,
  promoteGuardValidations,
  roleValueSets,
} from "../../engine/kb/boundary-observe.js";

// ---------------------------------------------------------------------------
// Part A — validation promoter.
// ---------------------------------------------------------------------------

function guard(
  message: string,
  messageKind: "stated" | "error-code",
  test = "someCondition",
  relPath = "internal/handlers/leave/service.go",
  startLine = 10,
  rejects = true,
): GuardRecord {
  const src = { ...lineRef("svc", relPath, startLine), startColumn: 2 };
  return {
    rootName: "svc",
    test,
    message,
    messageKind,
    rejects,
    enclosingFunction: "Create",
    source: src,
    provenance: resolved(src, "high"),
  };
}

describe("promoteGuardValidations", () => {
  it("promotes a stated-message guard to a validation rule keyed on the message", () => {
    const out = promoteGuardValidations([
      guard("Attachment is required.", "stated", "len(repr.Attachment) == 0"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("Attachment is required.");
    expect(out[0]!.expression).toBe("len(repr.Attachment) == 0");
    expect(out[0]!.field).toBeNull();
    expect(out[0]!.subjectSymbolId).toBeNull();
    expect(out[0]!.source.relPath).toBe("internal/handlers/leave/service.go");
  });

  it("drops an error-code guard (a named constant is not a stated rule)", () => {
    expect(promoteGuardValidations([guard("WKL_Forbidden", "error-code")])).toEqual([]);
  });

  it("drops a non-rejection guard (a value-return message is data, not a rule)", () => {
    // Same stated message, but the branch returns a value rather than rejecting.
    expect(promoteGuardValidations([guard("OT Pay label here", "stated", "u == OTTypePay", "a.go", 10, false)])).toEqual([]);
  });

  it("sorts by (rootName, relPath, startLine, startColumn, rule)", () => {
    const out = promoteGuardValidations([
      guard("Zeta rule here", "stated", "a", "b.go", 20),
      guard("Alpha rule here", "stated", "a", "a.go", 5),
    ]);
    expect(out.map((v) => v.source.relPath)).toEqual(["a.go", "b.go"]);
  });
});

// The promoter keys on guardsIn's real output. These run the actual reader on
// synthetic source so the message filter (>=6 chars, whitespace, not %s/%v/%d,
// error-plumbing dropped) is exercised end to end, not reimplemented in a fixture.
function guardsOf(language: "go" | "typescript", source: string): GuardRecord[] {
  const root = parseSource(language, source).root;
  if (root === null) throw new Error(`could not parse ${language} fixture`);
  return guardsIn(root, "svc", language === "go" ? "service.go" : "service.ts");
}

describe("promoteGuardValidations over real guardsIn output", () => {
  it("Go: an if-guard returning a custom error with a message → 1 validation", () => {
    const source = `package leave
func Create(x int) error {
	if x > 8 {
		return e.Err(400, "Too many hours requested")
	}
	return nil
}
`;
    const out = promoteGuardValidations(guardsOf("go", source));
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("Too many hours requested");
  });

  it("Go: error-propagation plumbing (if err != nil { return err }) → 0", () => {
    const source = `package leave
func Create() error {
	if err != nil {
		return err
	}
	return nil
}
`;
    expect(promoteGuardValidations(guardsOf("go", source))).toEqual([]);
  });

  it("Go: a short key and a format verb are not stated rules → 0", () => {
    const source = `package leave
func Create() error {
	if bad {
		return e.Err("id")
	}
	if worse {
		return fmt.Errorf("%s failed", name)
	}
	return nil
}
`;
    expect(promoteGuardValidations(guardsOf("go", source))).toEqual([]);
  });

  it("TS: if (!name) throw new Error(\"Name is required\") → 1 validation", () => {
    const source = `function create(name: string) {
  if (!name) { throw new Error("Name is required"); }
}
`;
    const out = promoteGuardValidations(guardsOf("typescript", source));
    expect(out).toHaveLength(1);
    expect(out[0]!.rule).toBe("Name is required");
  });

  it("Go: a bare value-return (return \"OT Pay\") is not a validation", () => {
    const source = `package leave
func DisplayName(u OTType) string {
	if u == OTTypePay {
		return "OT Pay label"
	}
	return "unknown"
}
`;
    expect(promoteGuardValidations(guardsOf("go", source))).toEqual([]);
  });

  it("Go: a success return (return Sucs(msg), nil) is not a validation", () => {
    const source = `package leave
func Cancel(app *App) (any, error) {
	if app.Status == constant.CancelledC {
		return cmon.SucsWithM("Already cancelled here."), nil
	}
	return nil, nil
}
`;
    expect(promoteGuardValidations(guardsOf("go", source))).toEqual([]);
  });

  it("Go: a query-builder value-return (return q.Where(...)) is not a validation", () => {
    const source = `package model
func activeQuery(q *gorm.DB, id uint64) *gorm.DB {
	if id > 0 {
		return q.Where("id != ?", id)
	}
	return q.Where("id != ?", 0)
}
`;
    expect(promoteGuardValidations(guardsOf("go", source))).toEqual([]);
  });

  it("Go: a genuine two-operand rejection (return nil, e.Msg(...)) is a validation", () => {
    const source = `package leave
func Create(repr *R) (any, error) {
	if len(repr.Attachment) == 0 {
		return nil, e.InvalidParamMsg("Attachment is required.")
	}
	return nil, nil
}
`;
    const out = promoteGuardValidations(guardsOf("go", source));
    expect(out.map((v) => v.rule)).toEqual(["Attachment is required."]);
  });
});

// ---------------------------------------------------------------------------
// Part B — authorization observer.
// ---------------------------------------------------------------------------

// A Go-shaped role vocabulary — one const block that declares numeric RoleC members
// and the string RoleF members alongside them, exactly what `valueSetsIn` extracts
// as a single set named after its first type, RoleC.
const roleC: ValueSet = {
  name: "RoleC",
  rootName: "svc",
  relPath: "internal/constant/role.go",
  startLine: 6,
  members: [
    { name: "EmployeeC", value: 1 },
    { name: "AdminC", value: 2 },
    { name: "ProjMngC", value: 3 },
    { name: "HRC", value: 4 },
    { name: "AdminF", value: "admin" },
    { name: "HRF", value: "hr_specialist" },
  ],
};

// A same-shaped non-role vocabulary: a status set no access-control token names.
const statusC: ValueSet = {
  name: "LvStatusC",
  rootName: "svc",
  relPath: "internal/constant/leave.go",
  startLine: 96,
  members: [
    { name: "WaitingC", value: 1 },
    { name: "ApprovedC", value: 4 },
  ],
};

describe("roleValueSets", () => {
  it("identifies a set by an access-control token in its name (role), not by role names", () => {
    const sets = roleValueSets([roleC, statusC]);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.name).toBe("RoleC");
  });

  it("leaves a set no access-control token names out", () => {
    expect(roleValueSets([statusC])).toEqual([]);
  });
});

describe("observeAuthInFile — Go role checks", () => {
  it("observes funk.Contains(roles, constant.AdminF.String()) — a call arg through .String()", () => {
    const source = `package leave
func Approve(cc *C) {
	isAdmin := funk.Contains(cc.Roles, constant.AdminF.String())
	_ = isAdmin
}
`;
    const auth = observeAuthInFile("svc", "internal/handlers/leave/service.go", source, [roleC]);
    expect(auth).toHaveLength(1);
    expect(auth[0]!.mechanism).toBe("role-membership");
    expect(auth[0]!.requirement).toBe("AdminF");
    expect(auth[0]!.symbolId).toBeNull();
    expect(auth[0]!.source.relPath).toBe("internal/handlers/leave/service.go");
  });

  it("observes a comparison operand (x == constant.AdminC)", () => {
    const source = `package leave
func Approve(x uint8) {
	if x == constant.AdminC {
		return
	}
}
`;
    const auth = observeAuthInFile("svc", "service.go", source, [roleC]);
    expect(auth.map((a) => a.requirement)).toEqual(["AdminC"]);
  });

  it("observes each member of an unkeyed composite handed to a call", () => {
    const source = `package leave
func Approve(cc *C) {
	hasPermission, err := model.HasPermissionWithRoles(
		cast.ToUint64(cc.Id),
		[]constant.RoleC{constant.AdminC, constant.HRC},
	)
	_, _ = hasPermission, err
}
`;
    const auth = observeAuthInFile("svc", "service.go", source, [roleC]);
    expect(auth.map((a) => a.requirement).sort()).toEqual(["AdminC", "HRC"]);
  });

  it("does not observe a keyed composite value (RoleID: constant.EmployeeC) — a role assignment", () => {
    const source = `package leave
func Assign(cc *C) {
	e := model.Emp{RoleID: constant.EmployeeC}
	_ = e
}
`;
    expect(observeAuthInFile("svc", "service.go", source, [roleC])).toEqual([]);
  });

  it("does not observe a role member handed to a logging sink (log.Info(\"role\", AdminC))", () => {
    const source = `package leave
func Trace(cc *C) {
	log.Info("role", constant.AdminC)
}
`;
    expect(observeAuthInFile("svc", "service.go", source, [roleC])).toEqual([]);
  });

  it("does not observe a role member handed to a format sink (fmt.Sprintf(\"%s\", AdminF.String()))", () => {
    const source = `package leave
func Label(cc *C) string {
	return fmt.Sprintf("%s", constant.AdminF.String())
}
`;
    expect(observeAuthInFile("svc", "service.go", source, [roleC])).toEqual([]);
  });

  it("does not observe a role member handed to a serialization sink (json.Marshal(AdminC))", () => {
    const source = `package leave
func Dump(cc *C) {
	b, _ := json.Marshal(constant.AdminC)
	_ = b
}
`;
    expect(observeAuthInFile("svc", "service.go", source, [roleC])).toEqual([]);
  });

  it("does not observe a comparison against a non-role value set (Status == ApprovedC)", () => {
    const source = `package leave
func Check(lv *Leave) {
	if lv.Status == constant.ApprovedC.Uint8() {
		return
	}
}
`;
    // Only the status set is in scope — no access-control token names it, so it is
    // never passed here; observing nothing is the point.
    expect(observeAuthInFile("svc", "service.go", source, roleValueSets([statusC]))).toEqual([]);
  });
});

describe("observeAuthInFile — TS enum role check", () => {
  const roleEnum: ValueSet = {
    name: "Role",
    rootName: "web",
    relPath: "src/role.ts",
    startLine: 1,
    members: [
      { name: "Admin", value: 0 },
      { name: "Hr", value: 1 },
    ],
  };

  it("observes if (u.role === Role.Admin) → 1 role-membership annotation", () => {
    const source = `function guard(u: any) {
  if (u.role === Role.Admin) { return; }
}
`;
    const auth = observeAuthInFile("web", "src/service.ts", source, [roleEnum]);
    expect(auth).toHaveLength(1);
    expect(auth[0]!.requirement).toBe("Admin");
  });

  it("does not observe the enum declaration itself, nor a role assignment (u.role = Role.Hr)", () => {
    const source = `enum Role { Admin, Hr }
function set(u: any) {
  u.role = Role.Hr;
}
`;
    expect(observeAuthInFile("web", "src/role.ts", source, [roleEnum])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// observeAuthorization — over roots, failing open.
// ---------------------------------------------------------------------------

describe("observeAuthorization — robustness", () => {
  function rootWith(rootName: string, analyzedFiles: readonly string[]): RootFacts {
    return { rootName, analyzedFiles } as unknown as RootFacts;
  }

  it("reads a root's files and yields deterministic annotations", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi86-"));
    writeFileSync(
      join(dir, "service.go"),
      `package leave
func Approve(x uint8) {
	if x == constant.AdminC {
		return
	}
}
`,
    );
    const result = observeAuthorization({
      roots: [rootWith("svc", ["service.go"])],
      valueSets: [{ ...roleC, rootName: "svc" }],
      rootPaths: new Map([["svc", dir]]),
    });
    expect(result.notes).toEqual([]);
    expect(result.auth.map((a) => a.requirement)).toEqual(["AdminC"]);
  });

  it("notes an unreadable file instead of throwing (machine-neutral, no fs message)", () => {
    const result = observeAuthorization({
      roots: [rootWith("svc", ["gone.go"])],
      valueSets: [{ ...roleC, rootName: "svc" }],
      rootPaths: new Map([["svc", "/nonexistent-dir"]]),
    });
    expect(result.auth).toEqual([]);
    expect(result.notes.join()).toContain("could not read svc/gone.go");
    // The absolute path from the raw fs message must not leak into the note.
    expect(result.notes.join()).not.toContain("/nonexistent-dir");
  });

  it("scans nothing when no value set is a role set", () => {
    const result = observeAuthorization({
      roots: [rootWith("svc", ["service.go"])],
      valueSets: [statusC],
      rootPaths: new Map([["svc", "/nonexistent"]]),
    });
    expect(result).toEqual({ auth: [], notes: [] });
  });
});
