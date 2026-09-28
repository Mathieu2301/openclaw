import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatReactionPerson,
  ChatReactionSummary,
} from "../../../../../packages/gateway-protocol/src/chat-reactions.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { ChatReactionsController, type ChatReactionScope } from "../chat-reactions.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender, resolveMessageActionDetails } from "./chat-message-markdown.ts";
import { ChatMessageReactions } from "./chat-message-reactions.ts";

let restoreDialog: () => void;
let container: HTMLElement;
beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  container = document.body.appendChild(document.createElement("div"));
});
afterEach(() => {
  render(null, container);
  container.remove();
  restoreDialog();
});

const maya: ChatReactionPerson = {
  identity: { type: "profile", id: "maya" },
  label: "Maya",
};
const noah: ChatReactionPerson = {
  identity: { type: "profile", id: "noah" },
  label: "Noah",
};
const summary: ChatReactionSummary = {
  emoji: "👍",
  count: 2,
  reactedByMe: false,
  reactors: [maya, noah],
  hasMoreReactors: false,
};
const agentPerson: ChatReactionPerson = {
  identity: { type: "agent", id: "maya" },
  label: "Atlas",
};
const mixedSummary: ChatReactionSummary = {
  ...summary,
  reactors: [maya, agentPerson],
};

async function setup(canReact = true, reaction = summary) {
  const request = createGatewayRequestMock().mockResolvedValue({
    sessionId: "s",
    messages: [{ messageId: "saved", reactions: [reaction] }],
  });
  const scope: ChatReactionScope = {
    client: createTestGatewayClient(request),
    connectionEpoch: 1,
    sessionKey: "agent:main:chat",
    agentId: "main",
    sessionId: "s",
    canReact,
    isCurrent: () => true,
  };
  const controller = new ChatReactionsController();
  controller.configure(scope);
  render(
    html`<openclaw-chat-message-reactions
      .controller=${controller}
      .messageId=${"saved"}
    ></openclaw-chat-message-reactions>`,
    container,
  );
  const element = container.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!;
  await element.updateComplete;
  await settle(element);
  return { request, controller, element, scope };
}
async function settle(element: ChatMessageReactions) {
  // The typed Gateway adapter awaits the wire handler before controller and Lit publication.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await element.updateComplete;
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === label,
  )!;
}

describe("message reaction controls", () => {
  it("exposes names, own state, disabled pending controls, and explicit retry", async () => {
    const { request, element } = await setup();
    const chip = container.querySelector<HTMLButtonElement>("[data-emoji]")!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("openclaw-tooltip")?.getAttribute("content")).toContain(
      "Maya, Noah",
    );
    const write = createDeferred<unknown>();
    request.mockReturnValueOnce(write.promise);
    chip.click();
    await element.updateComplete;
    expect(chip.disabled).toBe(true);
    expect(button("Add reaction").disabled).toBe(true);
    write.reject(new Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    await element.updateComplete;
    expect(container.textContent).toContain("Could not save your reaction.");
    const retry = container.querySelector<HTMLButtonElement>(".chat-reaction-error button")!;
    await settle(element);
    retry.click();
    await Promise.resolve();
    await element.updateComplete;
    expect(
      request.mock.calls
        .filter(([method]) => method === "chat.reactions.set")
        .map(([, params]) => (params as { active: boolean }).active),
    ).toEqual([true, true]);
  });

  it("uses the catalog picker and sends desired state without transcript changes", async () => {
    const { request, element } = await setup();
    button("Add reaction").click();
    await element.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(container.querySelectorAll(".chat-reaction-picker button")).toHaveLength(8);
    const search = container.querySelector<HTMLInputElement>("input[type=search]")!;
    search.value = "rocket";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await element.updateComplete;
    button("rocket").click();
    await element.updateComplete;
    expect(request).toHaveBeenCalledWith("chat.reactions.set", {
      sessionKey: "agent:main:chat",
      agentId: "main",
      sessionId: "s",
      messageId: "saved",
      emoji: "🚀",
      active: true,
    });
    expect(container.querySelector("wa-popup")).toBeNull();
  });

  it("lets readers inspect paginated people without a write and discards details after navigation", async () => {
    const { request, element, controller, scope } = await setup(false);
    expect(container.querySelector('[aria-label="Add reaction"]')).toBeNull();
    request.mockResolvedValueOnce({
      sessionId: "s",
      messageId: "saved",
      emoji: "👍",
      reactors: [maya],
      nextCursor: "next",
    });
    button("Who reacted with 👍").click();
    await settle(element);
    expect(container.querySelector(".chat-reaction-people")?.textContent).toContain("Maya");
    const pending = createDeferred<unknown>();
    request.mockReturnValueOnce(pending.promise);
    const more = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("Load more"),
    )!;
    more.click();
    await element.updateComplete;
    expect(request).toHaveBeenLastCalledWith(
      "chat.reactions.people",
      expect.objectContaining({ cursor: "next" }),
    );
    controller.configure({ ...scope, sessionId: "new" });
    pending.resolve({
      sessionId: "s",
      messageId: "saved",
      emoji: "👍",
      reactors: [noah],
    });
    await Promise.resolve();
    await element.updateComplete;
    expect(container.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "chat.reactions.set")).toBe(false);
  });

  it("labels agent names without treating their reaction as the current human's", async () => {
    const { request, element } = await setup(true, mixedSummary);
    expect(container.querySelector("openclaw-tooltip")?.getAttribute("content")).toBe(
      "Maya, Atlas (agent) reacted with 👍",
    );
    const chip = container.querySelector<HTMLButtonElement>("[data-emoji]")!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.closest(".chat-reaction-group")?.getAttribute("data-reacted")).toBe("false");
    chip.click();
    await settle(element);
    // agentId is the existing session target, never a supplied reactor identity.
    expect(request).toHaveBeenCalledWith("chat.reactions.set", {
      sessionKey: "agent:main:chat",
      agentId: "main",
      sessionId: "s",
      messageId: "saved",
      emoji: "👍",
      active: true,
    });
  });

  it("keeps colliding human and agent IDs distinct while reconciling paginated details", async () => {
    const { request, element } = await setup(false, mixedSummary);
    request.mockResolvedValueOnce({
      sessionId: "s",
      messageId: "saved",
      emoji: "👍",
      reactors: [maya, agentPerson],
      nextCursor: "next",
    });
    button("Who reacted with 👍").click();
    await settle(element);
    const labels = () =>
      [...container.querySelectorAll(".chat-reaction-people li > span:last-child")].map(
        (label) => label.textContent,
      );
    expect(labels()).toEqual(["Maya", "Atlas (agent)"]);
    request.mockResolvedValueOnce({
      sessionId: "s",
      messageId: "saved",
      emoji: "👍",
      reactors: [{ ...agentPerson, label: "Atlas updated" }, noah],
    });
    const more = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("Load more"),
    )!;
    more.click();
    await settle(element);
    expect(request).toHaveBeenLastCalledWith(
      "chat.reactions.people",
      expect.objectContaining({ cursor: "next" }),
    );
    expect(labels()).toEqual(["Maya", "Atlas updated (agent)", "Noah"]);
    expect(container.textContent).not.toContain("Load more");
    expect(request.mock.calls.some(([method]) => method === "chat.reactions.set")).toBe(false);
  });

  it("mounts both saved authors with canonical IDs, not grouping IDs, and omits pending messages", async () => {
    const { controller, request } = await setup();
    const saved = (role: string, id: string) => ({
      role,
      content: "message",
      __openclaw: { id, seq: 1 },
    });
    render(
      html`${[saved("user", "user-saved"), saved("assistant", "assistant-saved"), { ...saved("user", "pending"), __openclaw: { kind: "pending-send", id: "pending", state: "unconfirmed" } }].map((message, index) => renderGroupedMessage(prepareChatMessageRender(message), `group-${index}`, { isStreaming: false, showReasoning: false, reactions: controller, messageActions: resolveMessageActionDetails(prepareChatMessageRender(message), { messageId: `group-${index}`, senderLabel: "Person" }) }))}`,
      container,
    );
    const rows = [
      ...container.querySelectorAll<ChatMessageReactions>("openclaw-chat-message-reactions"),
    ];
    await Promise.all(rows.map((row) => row.updateComplete));
    await Promise.resolve();
    expect(rows.map((row) => row.messageId)).toEqual(["user-saved", "assistant-saved"]);
    expect(rows.map((row) => row.dataset.messageId)).toEqual(["user-saved", "assistant-saved"]);
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      messageIds: ["user-saved", "assistant-saved"],
    });
  });
});
