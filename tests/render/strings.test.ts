import { describe, expect, it } from "vitest";

import {
  applyGlossary,
  FRAME_EN,
  frameFor,
  heading,
  headingKey,
  needsTranslation,
  t,
} from "../../engine/render/strings.js";

describe("the report's frame words", () => {
  it("fills a template's placeholders with facts, leaving the words around them", () => {
    expect(t(FRAME_EN, "keeps-records", 15, "leave, holiday")).toBe(
      "It keeps 15 kinds of record. Among them: leave, holiday.",
    );
  });

  it("shows a missing key as itself rather than a blank, so a gap is visible", () => {
    expect(t({}, "stops-here")).toBe("[stops-here]");
  });

  it("adds each template heading as a key, so a new document translates unchanged", () => {
    const frame = frameFor(["What this is", "A heading no built-in template has"]);
    expect(frame[headingKey("A heading no built-in template has")]).toBe(
      "A heading no built-in template has",
    );
  });

  it("takes a translation over English, and keeps English where the translation is silent", () => {
    const translated = applyGlossary(FRAME_EN, { "stops-here": "到此结束", "col-from": "  " });
    // Supplied and non-blank: translated.
    expect(t(translated, "stops-here")).toBe("到此结束");
    // Blank in the translation: English kept rather than a blank cell.
    expect(t(translated, "col-from")).toBe("From");
    // Absent from the translation: English kept.
    expect(t(translated, "col-to")).toBe("To");
  });

  it("localises a heading only when the frame has it", () => {
    const frame = applyGlossary(frameFor(["What this is"]), {
      [headingKey("What this is")]: "这是什么",
    });
    expect(heading(frame, "What this is")).toBe("这是什么");
    expect(heading(frame, "Never declared")).toBe("Never declared");
  });

  it("needs a translation for anything but English", () => {
    expect(needsTranslation(undefined)).toBe(false);
    expect(needsTranslation("en")).toBe(false);
    expect(needsTranslation("en-GB")).toBe(false);
    expect(needsTranslation("English")).toBe(false);
    expect(needsTranslation("zh-CN")).toBe(true);
    expect(needsTranslation("ja")).toBe(true);
  });
});
