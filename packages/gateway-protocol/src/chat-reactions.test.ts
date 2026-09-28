import { describe, expect, it } from "vitest";
import { lazyCompile } from "./protocol-validator.js";
import {
  ChatReactionsPeopleResultSchema,
  ChatReactionsSetResultSchema,
} from "./schema/chat-reactions.js";
import {
  validateChatReactionsListParams,
  validateChatReactionsSetParams,
  validateChatReactionsPeopleParams,
} from "./validator-registry.js";

const target = { sessionKey: "agent:main:chat", sessionId: "saved-session" };

describe("chat reaction contracts", () => {
  it("requires the committed desired-state outcome", () => {
    const validate = lazyCompile(ChatReactionsSetResultSchema);
    expect(validate({ ok: true, changed: true })).toBe(true);
    expect(validate({ ok: true, changed: false })).toBe(true);
    expect(validate({ ok: true })).toBe(false);
  });
  it("presents profile and agent identities without legacy profile IDs", () => {
    const validate = lazyCompile(ChatReactionsPeopleResultSchema);
    const result = {
      sessionId: "saved-session",
      messageId: "saved-message",
      emoji: "👍",
      reactors: [
        { identity: { type: "profile", id: "same" }, label: "Human" },
        { identity: { type: "agent", id: "same" }, label: "Agent" },
      ],
    };
    expect(validate(result)).toBe(true);
    expect(validate({ ...result, reactors: [{ profileId: "same", label: "Human" }] })).toBe(false);
    expect(
      validate({
        ...result,
        reactors: [{ identity: { type: "remote", id: "same" }, label: "Remote" }],
      }),
    ).toBe(false);
  });
  it("bounds message batches and disallows caller-supplied actor identities", () => {
    expect(validateChatReactionsListParams({ ...target, messageIds: ["saved-message"] })).toBe(
      true,
    );
    expect(validateChatReactionsListParams({ ...target, messageIds: [] })).toBe(false);
    expect(validateChatReactionsListParams({ ...target, messageIds: ["same", "same"] })).toBe(
      false,
    );
    expect(
      validateChatReactionsListParams({
        ...target,
        messageIds: Array.from({ length: 101 }, (_, i) => String(i)),
      }),
    ).toBe(false);
    const set = { ...target, messageId: "saved-message", emoji: "👍", active: true };
    expect(validateChatReactionsSetParams(set)).toBe(true);
    expect(validateChatReactionsSetParams({ ...set, profileId: "someone-else" })).toBe(false);
    expect(validateChatReactionsSetParams({ ...set, reactor: { type: "agent", id: "main" } })).toBe(
      false,
    );
    expect(
      validateChatReactionsSetParams({ ...set, identity: { type: "agent", id: "main" } }),
    ).toBe(false);
    expect(validateChatReactionsSetParams({ ...set, active: undefined })).toBe(false);
    expect(
      validateChatReactionsPeopleParams({
        ...target,
        messageId: "saved-message",
        emoji: "👍",
        cursor: "a".repeat(513),
      }),
    ).toBe(false);
    expect(
      validateChatReactionsPeopleParams({ ...target, messageId: "saved-message", emoji: "👍" }),
    ).toBe(true);
  });
});
