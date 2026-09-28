import type { Page } from "playwright";
import type { ApplicationContext } from "../app/context.ts";

export async function refreshSessionRoster(currentPage: Page, sessionKey: string) {
  return currentPage.evaluate(async (key) => {
    const app = document.querySelector<
      HTMLElement & { runtime?: { context?: ApplicationContext } }
    >("openclaw-app");
    const sessions = app?.runtime?.context?.sessions;
    if (!sessions) {
      throw new Error("Session capability is missing");
    }
    await sessions.refresh({ agentId: "main", force: true });
    return sessions.state.result?.sessions.find((row) => row.key === key);
  }, sessionKey);
}
