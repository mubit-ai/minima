import { beforeEach, describe, expect, test } from "bun:test";
import {
  MAX_PENDING_ATTACHMENTS,
  addAttachment,
  attachmentToken,
  consumeAttachments,
  parseAttachmentTokens,
  pendingAttachmentCount,
  resetAttachments,
} from "../src/tui/attachments.ts";
import type { ClipboardImage } from "../src/tui/clipboard_image.ts";

const img = (data: string): ClipboardImage => ({
  data,
  mime: "image/png",
  bytes: data.length,
  width: 10,
  height: 10,
  resized: false,
});

beforeEach(() => {
  resetAttachments();
});

describe("token parsing (pure)", () => {
  test("ids come back in the order they appear in the text", () => {
    expect(parseAttachmentTokens("look at [Image #2] then [Image #1] please")).toEqual([2, 1]);
  });

  test("a repeated token counts once", () => {
    expect(parseAttachmentTokens("[Image #1] [Image #1]")).toEqual([1]);
  });

  test("text with no tokens parses to nothing", () => {
    expect(parseAttachmentTokens("just a normal prompt")).toEqual([]);
    expect(parseAttachmentTokens("[Image] [Image #] [image #1]")).toEqual([]);
  });

  test("the token renderer and the parser agree", () => {
    expect(parseAttachmentTokens(`a ${attachmentToken(7)} b`)).toEqual([7]);
  });
});

describe("the store", () => {
  test("a pasted image round-trips through its token", () => {
    const id = addAttachment(img("AAA"));
    const got = consumeAttachments(`describe ${attachmentToken(id)}`);
    expect(got.map((a) => a.data)).toEqual(["AAA"]);
    expect(got[0]).toMatchObject({ id, mime: "image/png" });
  });

  test("DELETING THE TOKEN DROPS THE IMAGE — the whole contract of this module", () => {
    addAttachment(img("AAA"));
    expect(consumeAttachments("I changed my mind, no image")).toEqual([]);
  });

  test("two images submit together, in draft order", () => {
    const a = addAttachment(img("AAA"));
    const b = addAttachment(img("BBB"));
    const got = consumeAttachments(`${attachmentToken(b)} vs ${attachmentToken(a)}`);
    expect(got.map((x) => x.data)).toEqual(["BBB", "AAA"]);
  });

  test("consuming removes them, so the next turn cannot resend the same image", () => {
    const id = addAttachment(img("AAA"));
    expect(consumeAttachments(attachmentToken(id))).toHaveLength(1);
    expect(consumeAttachments(attachmentToken(id))).toEqual([]);
    expect(pendingAttachmentCount()).toBe(0);
  });

  test("a hand-typed token for an id that was never stored is skipped, not thrown", () => {
    expect(consumeAttachments("[Image #99]")).toEqual([]);
  });

  test("ids are never reused, so a queued prompt keeps its own screenshot", () => {
    const first = addAttachment(img("QUEUED"));
    consumeAttachments(attachmentToken(first)); // the queued line is dispatched
    const second = addAttachment(img("NEXT"));
    expect(second).not.toBe(first);
  });

  test("an abandoned draft cannot grow the store without bound", () => {
    for (let i = 0; i < MAX_PENDING_ATTACHMENTS + 5; i++) addAttachment(img(`x${i}`));
    expect(pendingAttachmentCount()).toBe(MAX_PENDING_ATTACHMENTS);
    // The oldest went, the newest stayed — it is the one the user is looking at.
    const newest = MAX_PENDING_ATTACHMENTS + 5;
    expect(consumeAttachments(attachmentToken(newest))).toHaveLength(1);
    expect(consumeAttachments(attachmentToken(1))).toEqual([]);
  });
});
