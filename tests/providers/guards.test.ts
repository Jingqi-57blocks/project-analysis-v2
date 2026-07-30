import { describe, expect, it } from "vitest";

import { parseSource } from "../../engine/text/ast.js";
import { guardsIn } from "../../engine/providers/logic/provider.js";

function guards(source: string, file = "svc.go") {
  const parsed = parseSource(file.endsWith(".go") ? "go" : "typescript", source);
  return guardsIn(parsed.root!, "svc", file);
}

describe("guards — the gates that are not literal comparisons", () => {
  it("reads a gate that rejects through a call, and keeps its message", () => {
    const found = guards(`package svc
func Apply(p Project) error {
	if p.IsPresaleOrEOR() {
		return e.InvalidParamMsg("Leave is not supported for these projects")
	}
	return nil
}`);
    expect(found).toHaveLength(1);
    expect(found[0]!.test).toBe("p.IsPresaleOrEOR()");
    expect(found[0]!.message).toBe("Leave is not supported for these projects");
    expect(found[0]!.enclosingFunction).toBe("Apply");
  });

  it("reads a gate comparing two values, which the literal reader cannot", () => {
    const found = guards(`package svc
func Apply(available, requested float64) error {
	if available < requested {
		return e.InvalidParamMsg("Not enough holiday.")
	}
	return nil
}`);
    expect(found[0]!.message).toBe("Not enough holiday.");
    expect(found[0]!.test).toBe("available < requested");
  });

  it("leaves error-propagation guards out, message or not", () => {
    // `if err != nil { return err }` is plumbing, not a rule; and even with a
    // wrapped message it is a failure to do the work, not a rule for it.
    expect(
      guards(`package svc
func F() error {
	if err != nil {
		return err
	}
	return nil
}`),
    ).toEqual([]);
    expect(
      guards(`package svc
func F() error {
	if err != nil {
		return e.Wrap("could not read the record")
	}
	return nil
}`).map((g) => g.test),
    ).not.toContain("err != nil");
  });

  it("leaves a gate that rejects without any message out", () => {
    // Without a message there is nothing a `condition` or `decision` does not
    // already carry, so it adds only noise.
    expect(
      guards(`package svc
func F(x int) error {
	if x > 40 {
		return errTooLong
	}
	return nil
}`),
    ).toEqual([]);
  });

  it("does not take a format verb or a bare word as the rule's message", () => {
    expect(
      guards(`package svc
func F(id int) error {
	if id == 0 {
		return fmt.Errorf("id")
	}
	return nil
}`),
    ).toEqual([]);
  });

  it("reads the same shape in TypeScript", () => {
    const found = guards(
      `function apply(hours: number, attachment: string) {
  if (attachment.length === 0 && hours > 8) {
    throw new Error("Please upload a doctor's note for sick leave over a day");
  }
}`,
      "apply.ts",
    );
    expect(found[0]!.message).toBe("Please upload a doctor's note for sick leave over a day");
  });
});

describe("a rejection that names an error instead of stating a message", () => {
  it("records the constant's name, marked as a name rather than a sentence", () => {
    // WCP's older service throws `BusinessError(ErrorCodes.WKL_Forbidden)` 150
    // times, over the gates that are its real business rules. Reading only
    // string literals described that service as having almost no rules.
    const source = `function update(req, res) {
  if (worklog.userId !== req.user.id) {
    throw new BusinessError(ErrorCodes.WKL_Forbidden);
  }
  save(worklog);
}
`;
    const guard = guards(source, "worklogs.js")[0]!;
    expect(guard.message).toBe("WKL_Forbidden");
    expect(guard.messageKind).toBe("error-code");
    expect(guard.test).toBe("worklog.userId !== req.user.id");
  });

  it("prefers a stated message where the code states one", () => {
    const source = `function apply(req) {
  if (req.hours > 8) {
    throw new BusinessError(ErrorCodes.WKL_Forbidden, "Sick leave over one day needs a note");
  }
}
`;
    const guard = guards(source, "a.js")[0]!;
    expect(guard.message).toBe("Sick leave over one day needs a note");
    expect(guard.messageKind).toBe("stated");
  });

  it("still leaves error propagation out, however the error is named", () => {
    // `if err != nil { return ErrSomething_Bad }` is plumbing whichever
    // constant it returns.
    const source = `package svc
func F() error {
	if err != nil {
		return Err_Not_Found
	}
	return nil
}
`;
    expect(guards(source, "a.go")).toEqual([]);
  });

  it("does not mistake an ordinary local or a short name for an error constant", () => {
    const source = `function f(order) {
  if (order.total < 0) {
    throw new Error(total);
  }
  if (order.items.length === 0) {
    throw new Error(E_x);
  }
}
`;
    // `total` is lower-case with no word boundary; `E_x` is too short to be a
    // rule anyone could act on.
    expect(guards(source, "b.js")).toEqual([]);
  });
});
