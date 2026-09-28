import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

describe("reaction invalidation audience", () => {
  it("uses read scope and current session access without sending reactor identities", () => {
    const visible = makeClient("visible", "operator", ["operator.read"]);
    const hidden = makeClient("hidden", "operator", ["operator.read"]);
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    let allowed = true;
    const canReceiveSessionEvent = vi.fn((client, keys, agentId, event) => {
      expect(keys).toEqual(["agent:main:reactions"]);
      expect(agentId).toBe("main");
      expect(event).toBe("chat.reactions.changed");
      return allowed && client.connId === "visible";
    });
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([
        visible.client,
        hidden.client,
        pairing.client,
        node.client,
      ]),
      canReceiveSessionEvent,
    });
    const payload = {
      sessionKey: "agent:main:reactions",
      agentId: "main",
      sessionId: "saved",
      messageIds: ["message"],
    };
    broadcast("chat.reactions.changed", payload);
    expect(visible.socket.events).toEqual(["chat.reactions.changed"]);
    expect(hidden.socket.events).toEqual([]);
    expect(pairing.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    allowed = false;
    broadcast("chat.reactions.changed", payload);
    expect(visible.socket.events).toEqual(["chat.reactions.changed"]);
  });
});
