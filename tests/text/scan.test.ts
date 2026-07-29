import { describe, expect, it } from "vitest";

import { parseCalls, scanSource, stringLiteral, leadingName } from "../../engine/text/scan.js";

describe("stringLiteral", () => {
  it("reads a literal in any of the three quote styles", () => {
    expect(stringLiteral('"/v2/leaves"')).toBe("/v2/leaves");
    expect(stringLiteral("'/x'")).toBe("/x");
    expect(stringLiteral("`/y`")).toBe("/y");
  });

  it("refuses a concatenation that merely begins and ends with a quote", () => {
    // Otherwise the garbage between the outer quotes is published as a path.
    expect(stringLiteral('"/api" + version + "/users"')).toBeNull();
    expect(stringLiteral('PREFIX + "/x"')).toBeNull();
  });

  it("allows an escaped quote inside", () => {
    expect(stringLiteral('"it\\"s"')).toBe('it\\"s');
  });

  it("refuses anything that is not a literal at all", () => {
    expect(stringLiteral("handler")).toBeNull();
    expect(stringLiteral("")).toBeNull();
    expect(stringLiteral('"')).toBeNull();
  });
});

describe("parseCalls", () => {
  const pattern = /\b(\w+)\.(get|post)\s*\(/g;

  it("extracts arguments across several lines", () => {
    const content = "router.get(\n  '/me',\n  validate([1, 2]),\n  handler,\n);";
    const calls = parseCalls(content, scanSource(content), pattern);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["'/me'", "validate([1, 2])", "handler"]);
  });

  it("does not split an argument on a comma inside a string", () => {
    const content = "router.post('/a,b', handler);";
    const calls = parseCalls(content, scanSource(content), pattern);
    expect(calls[0]!.args).toEqual(["'/a,b'", "handler"]);
  });

  it("skips a call inside a comment", () => {
    const content = "// router.get('/old', h);\nrouter.get('/new', h);";
    const calls = parseCalls(content, scanSource(content), pattern);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe("'/new'");
  });

  it("does not carry match state between calls on different content", () => {
    // A module-level global regex would keep lastIndex and skip matches.
    const first = "router.get('/a', h);";
    const second = "router.get('/b', h);";

    expect(parseCalls(first, scanSource(first), pattern)).toHaveLength(1);
    expect(parseCalls(second, scanSource(second), pattern)).toHaveLength(1);
  });

  it("returns nothing for an unbalanced call rather than guessing", () => {
    const content = "router.get('/a', h";
    expect(parseCalls(content, scanSource(content), pattern)).toEqual([]);
  });
});

describe("scanSource", () => {
  it("does not treat a hash as a comment where a language uses it otherwise", () => {
    const content = 'const x = this.#field; const url = "/v2/x";';
    const map = scanSource(content, { hashLineComments: false });
    expect(map.comment[content.indexOf("/v2/x")]).toBe(0);
  });

  it("treats a hash as a comment where it is one", () => {
    const content = "# a comment\ncode";
    const map = scanSource(content, { hashLineComments: true });
    expect(map.comment[2]).toBe(1);
  });

  it("does not let a glob inside a string open a block comment", () => {
    const content = 'const g = "src/**/*.ts";\nconst url = "/v2/after";';
    const map = scanSource(content, { hashLineComments: false });
    expect(map.comment[content.indexOf("/v2/after")]).toBe(0);
  });
});

describe("leadingName", () => {
  it("takes the dotted identifier at the head of an expression", () => {
    expect(leadingName("auth.Authentication()")).toBe("auth.Authentication");
    expect(leadingName("passport.authenticate('jwt', {})")).toBe("passport.authenticate");
    expect(leadingName("(x) => y")).toBeNull();
  });
});
