import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  conventionCapabilities,
  createConventionsProvider,
} from "../../engine/providers/conventions/provider.js";
import { patternsFor } from "../../engine/providers/conventions/patterns.js";
import { capabilityFor, ANY_LANGUAGE } from "../../engine/structural/provider.js";

let workDir: string;

function write(relPath: string, content: string): void {
  const full = join(workDir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function extract(files: readonly string[]) {
  return createConventionsProvider().extract({ name: "svc", path: workDir, analyzedFiles: files });
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "pa-conventions-"));
});

afterEach(() => rmSync(workDir, { recursive: true, force: true }));

describe("validation rules", () => {
  it("finds Go binding tags and keeps the constraint verbatim", () => {
    write("model.go", 'type R struct {\n\tEmail string `json:"email" binding:"required,email"`\n}\n');

    const rules = extract(["model.go"]).records["validation-rule"];
    expect(rules).toHaveLength(1);
    expect(rules[0]!.rule).toBe("binding");
    expect(rules[0]!.expression).toBe("required,email");
  });

  it("finds decorator-based validators", () => {
    write("dto.ts", "class Dto {\n  @IsString()\n  name: string;\n  @IsOptional()\n  x?: number;\n}\n");
    expect(extract(["dto.ts"]).records["validation-rule"]).toHaveLength(2);
  });

  it("records the line the rule was found on", () => {
    write("model.go", 'package m\n\ntype R struct {\n\tX string `binding:"required"`\n}\n');
    expect(extract(["model.go"]).records["validation-rule"][0]!.source.startLine).toBe(4);
  });
});

describe("transactions and error handling", () => {
  it("finds an annotation-declared transaction", () => {
    write("Service.java", "@Transactional\npublic void save() {}\n");
    expect(extract(["Service.java"]).records["transaction-boundary"][0]!.mechanism).toBe(
      "@Transactional",
    );
  });

  it("finds Go error checks", () => {
    write("a.go", "x, err := f()\nif err != nil {\n\treturn err\n}\n");
    expect(extract(["a.go"]).records["error-handling"]).toHaveLength(1);
  });

  it("finds catch blocks", () => {
    write("a.ts", "try { f(); } catch (e) { g(); }\n");
    expect(extract(["a.ts"]).records["error-handling"]).toHaveLength(1);
  });
});

describe("auth and data access", () => {
  it("captures the requirement named in a guard", () => {
    write("c.ts", "@UseGuards(AuthGuard)\nclass C {}\n");
    const auth = extract(["c.ts"]).records["auth-annotation"];
    expect(auth[0]!.mechanism).toBe("guard");
    expect(auth[0]!.requirement).toBe("AuthGuard");
  });

  it("finds raw SQL in any language", () => {
    write("q.rb", 'sql = "SELECT * FROM users"\n');
    expect(extract(["q.rb"]).records["data-access"]).toHaveLength(1);
  });

  it("does not guess the entity a data access touches", () => {
    // Guessing would attach operations to tables that may not exist.
    write("r.go", "db.Find(&users)\n");
    const access = extract(["r.go"]).records["data-access"];
    expect(access[0]!.entity).toBeNull();
    expect(access[0]!.operation).toBe("unknown");
  });
});

describe("everything is an inference", () => {
  it("never marks a pattern match as declared", () => {
    // A regex cannot know whether a match is real code, a comment, or a string
    // in a fixture. Anything that must not repeat a guess filters these out.
    write("model.go", 'type R struct {\n\tX string `binding:"required"`\n}\n');
    write("a.go", "if err != nil {\n}\n");

    const contribution = extract(["model.go", "a.go"]);
    const all = [
      ...contribution.records["validation-rule"],
      ...contribution.records["error-handling"],
    ];

    expect(all.length).toBeGreaterThan(0);
    for (const record of all) {
      expect(record.provenance.resolutionClass).toBe("inferred");
    }
  });

  it("gives a weak signal low confidence and a specific one high", () => {
    write("model.go", 'type R struct {\n\tX string `binding:"required"`\n}\n');
    write("r.go", "db.Find(&x)\n");

    const strong = extract(["model.go"]).records["validation-rule"][0]!.provenance;
    const weak = extract(["r.go"]).records["data-access"][0]!.provenance;

    expect(strong.resolutionClass === "inferred" && strong.confidence).toBe("high");
    expect(weak.resolutionClass === "inferred" && weak.confidence).toBe("low");
  });
});

describe("scanning behaviour", () => {
  it("finds matches in every file, not only the first", () => {
    // A shared global regex carries lastIndex between calls and would skip
    // matches in every file after the first.
    write("a.go", "if err != nil {\n}\n");
    write("b.go", "if err != nil {\n}\n");
    write("c.go", "if err != nil {\n}\n");

    expect(extract(["a.go", "b.go", "c.go"]).records["error-handling"]).toHaveLength(3);
  });

  it("finds every occurrence within one file", () => {
    write("a.go", "if err != nil {\n}\nif err != nil {\n}\n");
    expect(extract(["a.go"]).records["error-handling"]).toHaveLength(2);
  });

  it("records an unreadable file as a failure without losing other files' matches", () => {
    write("good.go", "if err != nil {\n}\n");
    expect(extract(["good.go", "missing.go"]).records["error-handling"]).toHaveLength(1);
    expect(extract(["good.go", "missing.go"]).failures).toHaveLength(1);
  });

  it("applies language-specific patterns only to their languages", () => {
    write("a.py", "if err != nil {\n}\n");
    expect(extract(["a.py"]).records["error-handling"]).toEqual([]);
  });
});

describe("declared capabilities", () => {
  it("claims partial support only, naming the control-flow boundary", () => {
    for (const kind of ["validation-rule", "transaction-boundary", "error-handling"] as const) {
      const declaration = capabilityFor(conventionCapabilities(), kind, ANY_LANGUAGE);
      expect(declaration?.support).toBe("partial");
      expect(declaration?.limits.join(" ")).toContain("control flow is not reached");
    }
  });

  it("warns that textual matches can occur in comments or strings", () => {
    const declaration = capabilityFor(conventionCapabilities(), "validation-rule", ANY_LANGUAGE);
    expect(declaration?.limits.join(" ")).toContain("comments or strings");
  });

  it("applies language-agnostic patterns to any extension", () => {
    expect(patternsFor(".zig").some((p) => p.label === "sql")).toBe(true);
  });
});

describe("two matches on one line", () => {
  it("records a column, so facts sharing a line stay distinct when persisted", () => {
    // `db.Where(...).Find(...)` is two matches on one line. Without a column
    // they share a record key and the second is silently dropped at
    // persistence, with no gap and no conflict recorded.
    write("r.go", "db.Where(&q).Find(&users)\n");

    const access = extract(["r.go"]).records["data-access"];
    expect(access).toHaveLength(2);
    expect(access[0]!.provenance.source.startColumn).not.toBe(
      access[1]!.provenance.source.startColumn,
    );
  });
});

describe("scheduled work", () => {
  it("finds a node scheduler registration and keeps its first literal", () => {
    write(
      "schedule.js",
      "schedule.scheduleJob('Check-Mail', '30 * * * * *', function() { mail(); });\n",
    );
    const tasks = extract(["schedule.js"]).records["scheduled-task"];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.mechanism).toBe("scheduleJob");
    expect(tasks[0]!.schedule).toBe("Check-Mail");
  });

  it("finds a Go cron registration with its literal spec", () => {
    write(
      "cron.go",
      'package cron\n\nfunc Init(c *cron.Cron) {\n\tc.AddFunc("@every 5m", syncExpired)\n}\n',
    );
    const tasks = extract(["cron.go"]).records["scheduled-task"];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.schedule).toBe("@every 5m");
  });

  it("keeps a configured spec as null rather than inventing one", () => {
    // The schedule lives in configuration; the source states no timing.
    write("cron.go", "package cron\n\nfunc Init(c *cron.Cron) {\n\tc.AddFunc(cfg.Spec, run)\n}\n");
    const tasks = extract(["cron.go"]).records["scheduled-task"];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.schedule).toBeNull();
  });
});

describe("notifications", () => {
  it("finds a mail send and names its channel", () => {
    write("mail.js", "await this.mailTransport.sendMail({ to, subject });\n");
    const calls = extract(["mail.js"]).records["notification-call"];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe("mail");
  });

  it("finds a push send through firebase messaging", () => {
    write("push.js", "await admin.messaging().send(message);\n");
    const calls = extract(["push.js"]).records["notification-call"];
    expect(calls.map((call) => call.channel)).toContain("push");
  });

  it("marks a merely notification-named helper as weak evidence", () => {
    // A caller of the sender matches by name alone; the record must say so.
    write("svc.go", "package svc\n\nfunc F() {\n\tsendNotificationToLeader(ctx)\n}\n");
    const calls = extract(["svc.go"]).records["notification-call"];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.channel).toBe("unknown");
    const provenance = calls[0]!.provenance;
    expect(provenance.resolutionClass).toBe("inferred");
    expect("confidence" in provenance && provenance.confidence).toBe("low");
  });
});
