import { describe, expect, it } from "vitest";

import {
  applyGlossary,
  FRAME_EN,
  stopReason,
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

describe("why a trace stopped, in the report's language", () => {
  it("translates a reason the engine wrote when the frame has one", () => {
    // These sentences are stored with the flow as facts, in English. Rendered
    // as stored into a Chinese report, the one column a reader consults about
    // trust was in a language they may not read.
    const frame = applyGlossary(FRAME_EN, { "stop-no-caller": "没有发现任何调用方" });
    expect(
      stopReason(
        frame,
        "no call in the analyzed roots resolves to this endpoint; it may be called by something outside the workspace",
      ),
    ).toBe("没有发现任何调用方");
  });

  it("shows a reason it does not know as stored, rather than as a blank", () => {
    expect(stopReason(FRAME_EN, "something nobody has a key for")).toBe(
      "something nobody has a key for",
    );
  });
});
