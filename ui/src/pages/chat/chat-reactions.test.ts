import { describe, expect, it } from "vitest";
import type { ChatReactionsListResult } from "../../../../packages/gateway-protocol/src/chat-reactions.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { ChatReactionsController, type ChatReactionScope } from "./chat-reactions.ts";

function harness() {
  const request = createGatewayRequestMock();
  const scope: ChatReactionScope = {
    client: createTestGatewayClient(request),
    connectionEpoch: 1,
    sessionKey: "agent:main:test",
    agentId: "main",
    sessionId: "session",
    canReact: true,
    isCurrent: () => true,
  };
  const controller = new ChatReactionsController();
  controller.configure(scope);
  return { controller, scope, request };
}
const result = (count = 1, sessionId = "session"): ChatReactionsListResult => ({
  sessionId,
  messages: [
    {
      messageId: "one",
      reactions: [
        {
          emoji: "👍",
          count,
          reactedByMe: false,
          reactors: [{ identity: { type: "profile", id: "peer" }, label: "Peer" }],
          hasMoreReactors: false,
        },
      ],
    },
  ],
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("ChatReactionsController", () => {
  it("batches only mounted rows into bounded reads and drops unmounted cache entries", async () => {
    const { controller, request } = harness();
    request.mockResolvedValue({ sessionId: "session", messages: [] });
    const off = Array.from({ length: 205 }, (_, index) =>
      controller.subscribe(String(index), () => {}),
    );
    off[0]!();
    await flush();
    await flush();
    expect(
      request.mock.calls.map(
        ([, params]) => (params as { messageIds: string[] }).messageIds.length,
      ),
    ).toEqual([100, 100, 4]);
    expect(controller.read("0")).toBeUndefined();
    off.forEach((unsubscribe) => unsubscribe());
  });

  it.each(["sessionId", "agentId", "connectionEpoch", "client"] as const)(
    "rejects late results after %s changes",
    async (field) => {
      const { controller, request, scope } = harness();
      const oldRead = createDeferred<ChatReactionsListResult>();
      const freshRead = createDeferred<ChatReactionsListResult>();
      request.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise);
      controller.subscribe("one", () => {});
      await flush();
      const next = { ...scope };
      if (field === "sessionId") {
        next.sessionId = "new-session";
      }
      if (field === "agentId") {
        next.agentId = "other-agent";
      }
      if (field === "connectionEpoch") {
        next.connectionEpoch = 2;
      }
      if (field === "client") {
        next.client = createTestGatewayClient(request);
      }
      controller.configure(next);
      await flush();
      freshRead.resolve(result(2, next.sessionId));
      await flush();
      oldRead.resolve(result(99));
      await flush();
      expect(controller.read("one")?.reactions[0]?.count).toBe(2);
    },
  );

  it("does not apply an old window read to a remounted row", async () => {
    const { controller, request } = harness();
    const pending = createDeferred<ChatReactionsListResult>();
    request.mockReturnValueOnce(pending.promise).mockResolvedValue(result(2));
    const off = controller.subscribe("one", () => {});
    await flush();
    off();
    controller.subscribe("one", () => {});
    pending.resolve(result(99));
    await flush();
    await flush();
    expect(controller.read("one")?.reactions[0]?.count).toBe(2);
  });

  it("refreshes invalidation during an outstanding read and ignores other scopes", async () => {
    const { controller, request, scope } = harness();
    const pending = createDeferred<ChatReactionsListResult>();
    request.mockReturnValueOnce(pending.promise).mockResolvedValue(result(4));
    controller.subscribe("one", () => {});
    await flush();
    controller.changed({ ...scope, messageIds: ["one"] });
    pending.resolve(result(1));
    await flush();
    await flush();
    expect(controller.read("one")?.reactions[0]?.count).toBe(4);
    controller.changed({ ...scope, agentId: "other", messageIds: ["one"] });
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retains failed desired state for explicit retry, without a second pending write", async () => {
    const { controller, request } = harness();
    request.mockResolvedValue(result());
    controller.subscribe("one", () => {});
    await flush();
    const pending = createDeferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    const write = controller.set("one", "👍", true);
    await controller.set("one", "👍", false);
    expect(controller.read("one")?.pending).toBe(true);
    pending.reject(new Error("disconnected"));
    await write;
    await flush();
    expect(controller.read("one")?.error).toBe("save");
    controller.retry("one");
    await flush();
    const writes = request.mock.calls.filter(([method]) => method === "chat.reactions.set");
    expect(writes).toHaveLength(2);
    expect(writes.map(([, params]) => (params as { active: boolean }).active)).toEqual([
      true,
      true,
    ]);
    expect(controller.read("one")?.error).toBeUndefined();
  });

  it("never publishes a departed write or people result, and denies read-only writes", async () => {
    const { controller, request, scope } = harness();
    request.mockResolvedValue(result());
    controller.subscribe("one", () => {});
    await flush();
    const write = createDeferred<unknown>();
    const people = createDeferred<unknown>();
    request.mockReturnValueOnce(write.promise).mockReturnValueOnce(people.promise);
    const saving = controller.set("one", "👍", true);
    const reading = controller.people("one", "👍");
    controller.configure({ ...scope, sessionId: "new", canReact: false });
    write.reject(new Error("late failure"));
    people.resolve({ sessionId: "session", messageId: "one", emoji: "👍", reactors: [] });
    await saving;
    expect(await reading).toBeNull();
    expect(controller.read("one")?.error).not.toBe("save");
    await controller.set("one", "👍", true);
    expect(request.mock.calls.filter(([method]) => method === "chat.reactions.set")).toHaveLength(
      1,
    );
  });
});
