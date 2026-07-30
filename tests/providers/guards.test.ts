import { describe, expect, it } from "vitest";

import { parseSource } from "../../engine/text/ast.js";
import { createLogicProvider, guardsIn } from "../../engine/providers/logic/provider.js";

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

  it("does not mistake an ordinary local for an error constant", () => {
    // Every one of these was read as a business rule at some point. The last
    // is real: `found_level1` is a local in a vendored documentation script,
    // and it reached a WCP report as a rule the project enforces.
    const source = `function f(order) {
  if (order.total < 0) {
    throw new Error(total);
  }
  if (order.items.length === 0) {
    throw new Error(E_x);
  }
  if (!content) {
    return found_level1;
  }
  if (order.paid) {
    return snake_case_local;
  }
  if (order.rows > 0) {
    return REVENUE_CLIENT_ROW_HEIGHT;
  }
}
`;
    expect(guards(source, "b.js")).toEqual([]);
  });

  it("counts a named error only where the branch throws it", () => {
    // A branch that returns a constant is returning a value, not refusing to
    // work. `return DEFAULT_TITLE` and `return POSITIVE_INFINITY` were read as
    // rules WCP's browser application enforces.
    const returns = `function titleOf(page) {
  if (!page.title) {
    return DEFAULT_TITLE;
  }
  return page.title;
}
`;
    expect(guards(returns, "c.js")).toEqual([]);

    const throws = `function titleOf(page) {
  if (!page.title) {
    throw new BusinessError(ErrorCodes.CMN_Not_Found);
  }
}
`;
    expect(guards(throws, "d.js").map((guard) => guard.message)).toEqual(["CMN_Not_Found"]);
  });
});

describe("which symbol a named rejection is read as", () => {
  it("reads the error the throw names, not a constant nested in an argument", () => {
    // Searching the whole subtree took a SCREAMING_SNAKE identifier from
    // wherever it appeared, so an unrelated bound became the rule.
    const source = `function f(rows) {
  if (rows > 100) {
    throw new LimitError(compare(rows, MAX_ROWS));
  }
}
`;
    expect(guards(source, "a.js")).toEqual([]);
  });

  it("does not fall back to the object a member expression belongs to", () => {
    // `HTTP_STATUS.forbidden` names a status, not a rule; reporting the
    // container HTTP_STATUS as the rule is worse than reporting nothing.
    const source = `function f(user) {
  if (!user.admin) {
    throw new HttpError(HTTP_STATUS.forbidden);
  }
  if (!user.name) {
    throw new Error(ERROR_MESSAGES[code]);
  }
  if (!user.active) {
    throw new Error(t(I18N_KEYS.inactive));
  }
}
`;
    expect(guards(source, "b.js")).toEqual([]);
  });

  it("still reads the error code a rejection does name", () => {
    const source = `function f(worklog, user) {
  if (worklog.userId !== user.id) {
    throw new BusinessError(ErrorCodes.WKL_Forbidden);
  }
  if (!user.active) {
    throw USER_Permission_Deny;
  }
}
`;
    expect(guards(source, "c.js").map((guard) => guard.message)).toEqual([
      "WKL_Forbidden",
      "USER_Permission_Deny",
    ]);
  });
});

describe("a branch that returns markup", () => {
  function tsx(source: string) {
    const parsed = parseSource("tsx", source);
    return guardsIn(parsed.root!, "ui", "Thing.tsx").map((guard) => guard.message);
  }

  it("does not read a class name as a rule", () => {
    // The walk takes the first string in the returned subtree, and a component's
    // first string is usually a prop. This shipped 68 CSS class lists into one
    // browser application's business rules, two of which reached a recovered
    // specification under the heading "rules the system enforces".
    const messages = tsx(`function Row(props) {
  if (props.record.cancel_flag) {
    return <Button className="py-0 lh-base text-nowrap" variant="outline-primary" />;
  }
  return null;
}`);

    expect(messages).not.toContain("py-0 lh-base text-nowrap");
    expect(messages).toEqual([]);
  });

  it("still reads a rule the component states in a tooltip", () => {
    // Skipping markup wholesale was tried and cost real rules: this is how a
    // browser application states several of them, and none is a literal
    // comparison, so nothing else recovers them.
    const messages = tsx(`function Cell(props) {
  if (props.durationDays >= 30) {
    return <BSTooltip title="Exceeded the expect date by more than a month">
      <span className="text-nowrap text-danger">{props.children}</span>
    </BSTooltip>;
  }
  return null;
}`);

    expect(messages).toContain("Exceeded the expect date by more than a month");
    expect(messages).not.toContain("text-nowrap text-danger");
  });
});

describe("what the reader says it cannot do", () => {
  /** The declared limits for the rule reader, which reach every report. */
  function ruleLimits(): readonly string[] {
    const declared = createLogicProvider()
      .structuralCapabilities()
      .declarations.find((capability) => capability.kind === "guard");
    return declared?.limits ?? [];
  }

  it("declares that a templated message is quoted incompletely", () => {
    // A real `WKL_Already_Exist` rule ships as `Already have a work log for`, and
    // `entries[${i}].date must be YYYY-MM-DD` as `].date must be YYYY-MM-DD`. Left
    // undeclared, a reader takes both for the whole sentence.
    const limits = ruleLimits().join("\n");
    expect(limits).toContain("template");
    expect(limits).toContain("160");
    // And declares it in the shape the reader actually has: the first run of text
    // that reads like a sentence, which may begin *after* an interpolation —
    // `entries[${i}].date must be YYYY-MM-DD` arrives as `].date must be…`.
    expect(limits).not.toContain("only as far as its first interpolation");
    const found = guards(
      'function f(i, d) {\n  if (!d) {\n    throw new Error(`entries[${i}].date must be YYYY-MM-DD`);\n  }\n}',
      "mcp.js",
    );
    expect(found[0]?.message).toBe("].date must be YYYY-MM-DD");
  });

  it("declares that a prop stating a label is read as a rejection", () => {
    // The trade for keeping the four rules WCP states in a tooltip's title.
    expect(ruleLimits().join("\n")).toContain("props");
  });

  it("claims nothing about element text, which it never reads", () => {
    // The limit said a rule stated as element text is read as a rejection, which
    // invited a reader to discount valid rows for a class that cannot exist.
    expect(ruleLimits().join("\n")).not.toContain("element text");
    const found = guards(
      `function f(p) {
  if (p.x) {
    return <span>Amount must be positive here</span>;
  }
}`,
      "a.tsx",
    );
    expect(found).toEqual([]);
  });
});
