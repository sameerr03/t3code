import { describe, expect, it } from "vite-plus/test";

import { buildSelectedMessageReplyInsertion } from "./messageReply";

describe("buildSelectedMessageReplyInsertion", () => {
  it("formats selected message text as a markdown quote", () => {
    expect(buildSelectedMessageReplyInsertion("", "  First line\r\nSecond line  ")).toBe(
      "> First line\n> Second line\n\n",
    );
  });

  it("separates the quote from an existing reply", () => {
    expect(buildSelectedMessageReplyInsertion("My response", "quoted text")).toBe(
      "\n\n> quoted text\n\n",
    );
  });

  it("does not add another separator after a blank line", () => {
    expect(buildSelectedMessageReplyInsertion("My response\n\n", "quoted text")).toBe(
      "> quoted text\n\n",
    );
  });

  it("completes a blank line after one trailing newline", () => {
    expect(buildSelectedMessageReplyInsertion("My response\n", "quoted text")).toBe(
      "\n> quoted text\n\n",
    );
  });

  it("ignores empty selections", () => {
    expect(buildSelectedMessageReplyInsertion("Existing", " \n ")).toBe("");
  });
});
