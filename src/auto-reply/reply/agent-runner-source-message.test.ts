import { describe, expect, it } from "vitest";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { TemplateContext } from "../templating.js";
import { resolveReplyCurrentMessageId } from "./agent-runner-source-message.js";

const run = { agentId: "main", sessionId: "session-1", sessionKey: "agent:main:chat" };
const admission: UserTurnTranscriptAdmissionReceipt = {
  ...run,
  storePath: "/fixture/sessions",
  generation: "generation-1",
  entryId: "saved-user-event",
  rawSeq: 4,
  effectiveParentId: "previous-event",
  activeMessagePosition: 2,
  logicalTurnId: "logical-turn",
  role: "user",
  idempotencyKey: "client-run-id",
};

describe("reply current message identity", () => {
  it("uses only the committed WebChat entry while preserving source and prompt bytes", () => {
    const sessionCtx = Object.freeze({
      Provider: "webchat",
      MessageSid: "client-run-id",
      MessageSidFull: "queue-input-id",
      Body: "unchanged current user text",
      ReplyToId: "previous-event",
    });
    expect(resolveReplyCurrentMessageId({ sessionCtx, run })).toBeUndefined();
    expect(resolveReplyCurrentMessageId({ sessionCtx, run, userTurnAdmission: admission })).toBe(
      "saved-user-event",
    );
    expect(sessionCtx.MessageSid).toBe("client-run-id");
    expect(sessionCtx.MessageSidFull).toBe("queue-input-id");
    expect(sessionCtx.Body).toBe("unchanged current user text");
    expect(sessionCtx.ReplyToId).toBe("previous-event");
  });

  it.each([
    { agentId: "other" },
    { sessionId: "rotated-session" },
    { sessionKey: "agent:main:other" },
  ])("does not borrow another transcript receipt: %j", (override) => {
    expect(
      resolveReplyCurrentMessageId({
        sessionCtx: { Provider: "webchat", MessageSid: "client-run-id" },
        run: { ...run, ...override },
        userTurnAdmission: admission,
      }),
    ).toBeUndefined();
  });

  it.each([{ Provider: "discord" }, { Provider: "webchat", OriginatingChannel: "telegram" }])(
    "preserves external transport ids for %j",
    (route) => {
      expect(
        resolveReplyCurrentMessageId({
          sessionCtx: { ...route, MessageSid: "short-id", MessageSidFull: "transport-full-id" },
          run,
          userTurnAdmission: admission,
        }),
      ).toBe("transport-full-id");
    },
  );

  it.each([undefined, "original-source-message"])(
    "preserves restart-sentinel reply identity (%s), not the synthetic or saved continuation",
    (replyToId) => {
      const sessionCtx: TemplateContext = {
        Provider: "webchat",
        MessageSid: "restart-sentinel:synthetic",
        ReplyToId: replyToId,
        InputProvenance: { kind: "internal_system", sourceTool: "restart-sentinel" },
      };
      expect(resolveReplyCurrentMessageId({ sessionCtx, run, userTurnAdmission: admission })).toBe(
        replyToId,
      );
    },
  );
});
