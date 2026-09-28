import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import {
  agentReactionMessageId,
  aria,
  atlas,
  currentPerson,
  humanReactionMessageId,
  maya,
  noah,
  reactionList,
  reactionScenario,
  reactionSessionId,
  reactionSessionKey,
} from "./chat-reactions.test-support.ts";

const suite = createChatFlowE2eSuite();

async function expectSharedActionRow(row: Locator): Promise<void> {
  await row.scrollIntoViewIfNeeded();
  const geometry = await row.evaluate((element) => {
    const reactions = element.querySelector(".chat-reaction-add");
    const copy = element.querySelector(".chat-copy-btn");
    const reply = element.querySelector(".chat-reply-btn");
    if (!reactions || !copy || !reply) {
      throw new Error("Missing shared message actions");
    }
    const box = (item: Element) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2 };
    };
    return {
      reactions: box(reactions),
      copy: box(copy),
      reply: box(reply),
      tail: [...element.querySelectorAll(".chat-reactions button")]
        .slice(-2)
        .map((button) => button.getAttribute("aria-label")),
    };
  });
  expect(geometry.copy.left).toBeGreaterThanOrEqual(geometry.reactions.right);
  expect(geometry.reply.left).toBeGreaterThanOrEqual(geometry.copy.right);
  expect(Math.abs(geometry.copy.centerY - geometry.reactions.centerY)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.reply.centerY - geometry.reactions.centerY)).toBeLessThanOrEqual(1);
  expect(geometry.tail).toEqual(["Copy as markdown", "Reply to message"]);
}

async function expectCompactPicker(picker: Locator) {
  await picker.waitFor({ state: "visible" });
  const geometry = await picker.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const choices = element.querySelector(".chat-reaction-picker")!.getBoundingClientRect();
    const search = element.querySelector("input")!.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      left: box.left,
      right: box.right,
      viewport: window.innerWidth,
      choicesBottom: choices.bottom,
      searchTop: search.top,
      modal: element.getAttribute("aria-modal"),
      count: element.querySelectorAll(".chat-reaction-picker button").length,
      editing: element.ownerDocument.activeElement instanceof HTMLInputElement,
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(280);
  expect(geometry.height).toBeLessThanOrEqual(260);
  expect(geometry.left).toBeGreaterThanOrEqual(8);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport - 8);
  expect(geometry.searchTop).toBeGreaterThanOrEqual(geometry.choicesBottom);
  expect(geometry.modal).not.toBe("true");
  expect(geometry.count).toBe(8);
  expect(geometry.editing).toBe(false);
}

suite.define(() => {
  it("keeps reactions, Copy, and final Reply in one row across desktop and mobile while syncing shared state", async () => {
    const context = await suite.newBrowserContext({
      viewport: { width: 1280, height: 820 },
      colorScheme: "dark",
      locale: "en-US",
    });
    try {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, reactionScenario());
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, reactionSessionKey));
      const agent = page.locator(
        'openclaw-chat-message-reactions[data-message-id="' + agentReactionMessageId + '"]',
      );
      const human = page.locator(
        'openclaw-chat-message-reactions[data-message-id="' + humanReactionMessageId + '"]',
      );
      const thumb = agent.locator('[data-emoji="👍"]');
      await thumb.waitFor({ state: "visible" });
      await human.locator('[data-emoji="👀"]').waitFor({ state: "visible" });
      expect(await thumb.getAttribute("aria-pressed")).toBe("false");
      await thumb.hover();
      const namesBubble = thumb.locator("../..").locator("wa-tooltip[open] .tooltip-content");
      await namesBubble.waitFor({ state: "visible" });
      expect(await namesBubble.textContent()).toContain(
        "Maya, Atlas (agent), Aria reacted with 👍",
      );
      await page.keyboard.press("Escape");
      await namesBubble.waitFor({ state: "hidden" });
      await expectSharedActionRow(agent);
      await expectSharedActionRow(human);
      for (const row of [agent, human]) {
        expect(
          await row.evaluate(
            (element) => element.closest(".chat-group")?.querySelectorAll(".chat-copy-btn").length,
          ),
        ).toBe(1);
        expect(
          await row.evaluate(
            (element) => element.closest(".chat-group")?.querySelectorAll(".chat-reply-btn").length,
          ),
        ).toBe(1);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await expectSharedActionRow(agent);
      await expectSharedActionRow(human);
      await page.setViewportSize({ width: 1280, height: 820 });
      const addReaction = agent.getByRole("button", { name: "Add reaction", exact: true });
      expect(await addReaction.getAttribute("aria-expanded")).toBe("false");
      await addReaction.focus();
      await page.keyboard.press("Enter");
      const picker = page.getByRole("dialog", { name: "Add reaction", exact: true });
      await expectCompactPicker(picker);
      expect(
        await picker
          .getByRole("button", { name: "thumbsup", exact: true })
          .evaluate((button) => document.activeElement === button),
      ).toBe(true);
      expect(await addReaction.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      await picker.waitFor({ state: "hidden" });
      expect(await addReaction.getAttribute("aria-expanded")).toBe("false");
      expect(await addReaction.evaluate((button) => document.activeElement === button)).toBe(true);
      await addReaction.click();
      await expectCompactPicker(picker);
      await page.locator(".agent-chat__composer-combobox textarea").click();
      await picker.waitFor({ state: "hidden" });
      const initial = await gateway.getRequests("chat.reactions.list");
      const ids = initial.flatMap((request) => requireRecord(request.params).messageIds);
      expect(ids).toContain(humanReactionMessageId);
      expect(ids).toContain(agentReactionMessageId);

      await gateway.deferNext("chat.reactions.set");
      await thumb.click();
      const add = requireRecord((await gateway.waitForRequest("chat.reactions.set")).params);
      expect(add).toEqual({
        sessionKey: reactionSessionKey,
        agentId: "main",
        sessionId: reactionSessionId,
        messageId: agentReactionMessageId,
        emoji: "👍",
        active: true,
      });
      expect(await thumb.isDisabled()).toBe(true);
      await gateway.setMethodResponse("chat.reactions.list", reactionList(true));
      await gateway.resolveDeferred("chat.reactions.set", { ok: true, changed: true });
      await agent.locator('[data-emoji="👍"][aria-pressed="true"]:not(:disabled)').waitFor();
      expect(await thumb.locator("..").textContent()).toContain("4");

      await gateway.setMethodResponse("chat.reactions.list", reactionList(true, true));
      await gateway.emitGatewayEvent("chat.reactions.changed", {
        sessionKey: reactionSessionKey,
        agentId: "main",
        sessionId: reactionSessionId,
        messageIds: [agentReactionMessageId],
      });
      await thumb.locator("..").filter({ hasText: "5" }).waitFor();
      await gateway.setMethodResponse("chat.reactions.people", {
        sessionId: reactionSessionId,
        messageId: agentReactionMessageId,
        emoji: "👍",
        reactors: [maya, atlas, aria, currentPerson, noah],
      });
      const writesBeforeDetails = (await gateway.getRequests("chat.reactions.set")).length;
      await agent.getByRole("button", { name: "Who reacted with 👍", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor({ state: "visible" });
      const people = page.locator(".chat-reaction-dialog");
      await people.getByText("Maya", { exact: true }).waitFor();
      await people.getByText("Atlas (agent)", { exact: true }).waitFor();
      await people.getByText("Noah", { exact: true }).waitFor();
      expect((await gateway.getRequests("chat.reactions.set")).length).toBe(writesBeforeDetails);
      await page.keyboard.press("Escape");
      await people.waitFor({ state: "hidden" });

      await gateway.deferNext("chat.reactions.set");
      await thumb.click();
      const remove = requireRecord(
        (await gateway.waitForRequest("chat.reactions.set", { after: writesBeforeDetails })).params,
      );
      expect(remove).toMatchObject({
        messageId: agentReactionMessageId,
        emoji: "👍",
        active: false,
      });
      await gateway.setMethodResponse("chat.reactions.list", reactionList(false, true));
      await gateway.resolveDeferred("chat.reactions.set", { ok: true, changed: true });
      await agent.locator('[data-emoji="👍"][aria-pressed="false"]:not(:disabled)').waitFor();
      expect(await thumb.locator("..").textContent()).toContain("4");

      await gateway.deferNext("chat.reactions.set");
      await human.locator('[data-emoji="👀"]').click();
      const humanWrite = requireRecord(
        (await gateway.waitForRequest("chat.reactions.set", { after: writesBeforeDetails + 1 }))
          .params,
      );
      expect(humanWrite).toMatchObject({
        messageId: humanReactionMessageId,
        emoji: "👀",
        active: true,
      });
      await gateway.rejectDeferred("chat.reactions.set", {
        code: "FORBIDDEN",
        message: "Session participation changed",
      });
      await human.getByRole("button", { name: /retry/i }).waitFor();
      expect(await human.locator('[data-emoji="👀"]').getAttribute("aria-pressed")).toBe("false");
      await expectSharedActionRow(human);
      await agent.getByRole("button", { name: "Reply to message", exact: true }).click();
      await page
        .locator(".chat-reply-preview__text")
        .filter({ hasText: "Thursday looks good" })
        .waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([false, true])(
    "reveals names by tapping the count without a reaction write (incognito: %s)",
    async (incognito) => {
      const context = await suite.newBrowserContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        colorScheme: "dark",
        locale: "en-US",
      });
      try {
        const page = await context.newPage();
        const scenario = reactionScenario();
        const sessionKey = incognito
          ? "agent:main:dashboard:incognito-reaction-demo"
          : reactionSessionKey;
        scenario.sessionKey = sessionKey;
        scenario.sessions = scenario.sessions?.map((session) => ({
          ...session,
          key: sessionKey,
          incognito,
        }));
        scenario.methodResponses = {
          ...scenario.methodResponses,
          "chat.reactions.people": {
            sessionId: reactionSessionId,
            messageId: agentReactionMessageId,
            emoji: "👍",
            reactors: [maya, atlas, aria],
          },
        };
        const gateway = await installMockGateway(page, scenario);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const count = page.getByRole("button", { name: "Who reacted with 👍", exact: true });
        await count.waitFor({ state: "visible" });
        const box = await count.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(40);
        expect(box?.height).toBeGreaterThanOrEqual(40);
        const add = page.getByRole("button", { name: "Add reaction", exact: true }).last();
        await add.tap();
        const picker = page.getByRole("dialog", { name: "Add reaction", exact: true });
        await expectCompactPicker(picker);
        await picker.getByRole("searchbox", { name: "Search emoji" }).fill("rocket");
        await picker.getByRole("button", { name: "rocket", exact: true }).tap();
        await picker.waitFor({ state: "hidden" });
        const write = requireRecord((await gateway.waitForRequest("chat.reactions.set")).params);
        expect(write).toMatchObject({ emoji: "🚀", active: true });
        await count.tap();
        await page
          .getByRole("dialog", { name: "Who reacted", exact: true })
          .waitFor({ state: "visible" });
        await page.locator(".chat-reaction-people").getByText("Maya", { exact: true }).waitFor();
        await page
          .locator(".chat-reaction-people")
          .getByText("Atlas (agent)", { exact: true })
          .waitFor();
        expect(await gateway.getRequests("chat.reactions.set")).toHaveLength(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
