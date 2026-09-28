import { html, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { ChatReactionPerson } from "../../../../../packages/gateway-protocol/src/chat-reactions.js";
import type { OpenClawModalDialog } from "../../../components/modal-dialog.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../../test-helpers/gateway-client.ts";
import "../../../styles.css";
import { ChatReactionsController } from "../chat-reactions.ts";
import { ChatMessageReactions } from "./chat-message-reactions.ts";

const reactors: ChatReactionPerson[] = [
  { identity: { type: "profile", id: "maya" }, label: "Maya" },
  { identity: { type: "agent", id: "atlas" }, label: "Atlas" },
];

let host: HTMLElement;
afterEach(() => {
  if (host) {
    render(null, host);
    host.remove();
  }
});

it("supports keyboard picker selection, focus names and non-mutating people dialog", async () => {
  const request = createGatewayRequestMock().mockResolvedValue({
    sessionId: "s",
    messages: [
      {
        messageId: "saved",
        reactions: [
          {
            emoji: "👍",
            count: 2,
            reactedByMe: false,
            reactors,
            hasMoreReactors: false,
          },
        ],
      },
    ],
  });
  const controller = new ChatReactionsController();
  controller.configure({
    client: createTestGatewayClient(request),
    connectionEpoch: 1,
    sessionKey: "agent:main:chat",
    agentId: "main",
    sessionId: "s",
    canReact: true,
    isCurrent: () => true,
  });
  host = document.body.appendChild(document.createElement("div"));
  render(
    html`<openclaw-chat-message-reactions
      .controller=${controller}
      .messageId=${"saved"}
    ></openclaw-chat-message-reactions>`,
    host,
  );
  const element = host.querySelector<ChatMessageReactions>("openclaw-chat-message-reactions")!;
  await element.updateComplete;
  await expect.element(page.getByRole("button", { name: "👍, 2 reactions" })).toBeVisible();
  const chip = host.querySelector<HTMLButtonElement>("[data-emoji]")!;
  chip.focus();
  expect(chip.getAttribute("aria-describedby")).toBeTruthy();
  const tooltip = host.querySelector("openclaw-tooltip")!;
  expect(tooltip.getAttribute("content")).toBe("Maya, Atlas (agent) reacted with 👍");
  const add = host.querySelector<HTMLButtonElement>('[aria-label="Add reaction"]')!;
  add.focus();
  await userEvent.keyboard("{Enter}");
  await element.updateComplete;
  await page.getByRole("searchbox", { name: "Search emoji" }).fill("rocket");
  await element.updateComplete;
  const rocket = host.querySelector<HTMLButtonElement>('[aria-label="rocket"]')!;
  rocket.focus();
  await userEvent.keyboard("{Enter}");
  await element.updateComplete;
  expect(request).toHaveBeenCalledWith(
    "chat.reactions.set",
    expect.objectContaining({ messageId: "saved", emoji: "🚀", active: true }),
  );
  request.mockResolvedValueOnce({
    sessionId: "s",
    messageId: "saved",
    emoji: "👍",
    reactors,
  });
  const details = host.querySelector<HTMLButtonElement>('[aria-label="Who reacted with 👍"]')!;
  details.focus();
  await userEvent.keyboard("{Enter}");
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
  const modal = host.querySelector<OpenClawModalDialog>("openclaw-modal-dialog")!;
  await modal.updateComplete;
  await expect.element(page.getByRole("dialog", { name: "Who reacted" })).toBeVisible();
  await expect.element(page.getByText("Maya", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Atlas (agent)", { exact: true })).toBeVisible();
  expect(request.mock.calls.filter(([method]) => method === "chat.reactions.set")).toHaveLength(1);
  await userEvent.keyboard("{Escape}");
  await element.updateComplete;
  await expect.element(page.getByRole("dialog", { name: "Who reacted" })).not.toBeInTheDocument();
  expect(document.activeElement).toBe(details);
});
