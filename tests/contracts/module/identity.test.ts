import { describe, expect, it } from "vitest";

import {
  UnresolvedModuleError,
  categorize,
  identityFingerprint,
  looksAbbreviated,
  normalizeRef,
  resolveModuleRef,
  unexplainedIdentifiers,
  validateDirectory,
  validateGlossary,
  type ModuleDirectory,
} from "../../../engine/contracts/module/index.js";

const directory: ModuleDirectory = {
  identities: [
    {
      id: "mod_a",
      structuralName: "leaves",
      category: "product-capability",
      rootNames: ["svc", "svc-v2"],
      aliases: ["time-off"],
    },
    { id: "mod_b", structuralName: "billing", category: "product-capability", rootNames: ["svc-v2"], aliases: [] },
    { id: "mod_c", structuralName: "support", category: "technical-component", rootNames: ["svc-v2"], aliases: [] },
  ],
  displayNames: [
    { moduleId: "mod_a", language: "zh-CN", name: "请假" },
    { moduleId: "mod_b", language: "zh-CN", name: "账单" },
    { moduleId: "mod_c", language: "zh-CN", name: "支撑数据" },
    { moduleId: "mod_a", language: "en", name: "Leave" },
    { moduleId: "mod_b", language: "en", name: "Billing" },
    { moduleId: "mod_c", language: "en", name: "Supporting data" },
  ],
};

describe("module addressing", () => {
  it("resolves by id", () => {
    expect(resolveModuleRef(directory, "mod_a").structuralName).toBe("leaves");
  });

  it("resolves by structural name across a plural difference", () => {
    // The report vocabulary says `leave`; the store formed `leaves`. Making the
    // user know which spelling the analyser chose would be a poor contract.
    expect(resolveModuleRef(directory, "leave").id).toBe("mod_a");
    expect(resolveModuleRef(directory, "leaves").id).toBe("mod_a");
  });

  it("resolves by a display name in either language, to the same module", () => {
    expect(resolveModuleRef(directory, "请假").id).toBe("mod_a");
    expect(resolveModuleRef(directory, "Leave").id).toBe("mod_a");
    expect(resolveModuleRef(directory, "leave").id).toBe(resolveModuleRef(directory, "请假").id);
  });

  it("resolves by a historical alias", () => {
    expect(resolveModuleRef(directory, "time-off").id).toBe("mod_a");
  });

  it("fails closed on an unknown reference, and never widens to the project", () => {
    expect(() => resolveModuleRef(directory, "nope")).toThrow(UnresolvedModuleError);
    try {
      resolveModuleRef(directory, "nope");
    } catch (error) {
      expect((error as UnresolvedModuleError).known).toContain("leaves");
    }
  });

  it("fails rather than guessing when a reference is ambiguous", () => {
    const ambiguous: ModuleDirectory = {
      identities: [
        { id: "m1", structuralName: "reports", category: "aggregate-entry", rootNames: ["a"], aliases: [] },
        { id: "m2", structuralName: "report", category: "aggregate-entry", rootNames: ["b"], aliases: [] },
      ],
      displayNames: [],
    };
    expect(() => resolveModuleRef(ambiguous, "report")).toThrow(UnresolvedModuleError);
  });

  it("folds case, separators and plurals the same way", () => {
    expect(normalizeRef("Leave_Management")).toBe(normalizeRef("leave management"));
    expect(normalizeRef("policies")).toBe(normalizeRef("policy"));
  });
});

describe("language does not touch identity", () => {
  it("gives the same fingerprint whatever language is rendered", () => {
    const zhOnly: ModuleDirectory = {
      identities: directory.identities,
      displayNames: directory.displayNames.filter((d) => d.language === "zh-CN"),
    };
    const enOnly: ModuleDirectory = {
      identities: directory.identities,
      displayNames: directory.displayNames.filter((d) => d.language === "en"),
    };
    expect(identityFingerprint(zhOnly)).toEqual(identityFingerprint(enOnly));
    expect(zhOnly.identities).toHaveLength(enOnly.identities.length);
  });

  it("validates a complete directory", () => {
    const result = validateDirectory(directory);
    expect(result.ok ? [] : result.reasons).toEqual([]);
  });

  it("rejects a language whose display names are incomplete", () => {
    const partial: ModuleDirectory = {
      identities: directory.identities,
      displayNames: directory.displayNames.filter((d) => d.moduleId !== "mod_c"),
    };
    const result = validateDirectory(partial);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("display names for 3 modules");
  });

  it("rejects two modules sharing one display name", () => {
    const clashing: ModuleDirectory = {
      identities: directory.identities,
      displayNames: [
        { moduleId: "mod_a", language: "en", name: "Leave" },
        { moduleId: "mod_b", language: "en", name: "Leave" },
        { moduleId: "mod_c", language: "en", name: "Supporting data" },
      ],
    };
    const result = validateDirectory(clashing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("names both");
  });
});

describe("structural categories", () => {
  const shape = (over: Partial<Parameters<typeof categorize>[0]>) =>
    categorize({
      endpointCount: 0,
      dataEntityCount: 0,
      outboundTargetCount: 0,
      symbolCount: 0,
      dependentCount: 0,
      ...over,
    });

  it("keys only on counts, so the rules hold for any project", () => {
    expect(shape({ endpointCount: 5, dataEntityCount: 3 })).toBe("product-capability");
    expect(shape({ endpointCount: 5 })).toBe("aggregate-entry");
    expect(shape({ dependentCount: 4, symbolCount: 10 })).toBe("technical-component");
    expect(shape({ outboundTargetCount: 2 })).toBe("external");
    expect(shape({})).toBe("infrastructure");
  });
});

describe("three-column glossary", () => {
  const glossary = {
    sourceLanguage: "zh-CN",
    targetLanguage: "es",
    entries: [
      { identifier: "wcp_leave", sourceName: "请假记录", targetName: "Registro de permiso" },
      { identifier: "MR", sourceName: "主评人", targetName: "Revisor principal", expansion: "main reviewer" },
    ],
  };

  it("accepts a complete glossary", () => {
    const result = validateGlossary(glossary);
    expect(result.ok ? [] : result.reasons).toEqual([]);
  });

  it("rejects an entry missing any of the three columns", () => {
    for (const missing of ["identifier", "sourceName", "targetName"] as const) {
      const broken = { ...glossary, entries: [{ ...glossary.entries[0]!, [missing]: "" }] };
      expect(validateGlossary(broken).ok).toBe(false);
    }
  });

  it("rejects an abbreviation published without its expansion", () => {
    const broken = {
      ...glossary,
      entries: [{ identifier: "MR", sourceName: "主评人", targetName: "Revisor principal" }],
    };
    const result = validateGlossary(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toContain("abbreviation");
  });

  it("recognises abbreviations without knowing any particular project", () => {
    expect(looksAbbreviated("MR")).toBe(true);
    expect(looksAbbreviated("PrmtAplr")).toBe(false);
    expect(looksAbbreviated("wcp_leave")).toBe(false);
    expect(looksAbbreviated("leave")).toBe(false);
  });

  it("names identifiers the report used but the glossary never explains", () => {
    expect(unexplainedIdentifiers(glossary, ["wcp_leave", "wcp_approve"])).toEqual(["wcp_approve"]);
  });
});
