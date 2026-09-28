import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveActiveEmbeddedRunSessionId } from "../embedded-agent-runner/active-run-projections.js";
import {
  queueEmbeddedAgentMessageWithOutcomeAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
} from "../embedded-agent-runner/runs.js";
import { startSessionsSendAgentRun } from "./sessions-send-tool.delivery.js";
import { prepareSessionToolControlTarget } from "./sessions-tool-control.js";

vi.mock("../embedded-agent-runner/active-run-projections.js", () => ({
  resolveActiveEmbeddedRunSessionId: vi.fn(() => "active-session"),
}));
vi.mock("../embedded-agent-runner/runs.js", () => ({
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(async () => ({ queued: true })),
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync: vi.fn(async () => ({ queued: true })),
}));
vi.mock("./sessions-tool-control.js", () => ({
  prepareSessionToolControlTarget: vi.fn(async () => {
    throw new Error("session control denied");
  }),
}));

it.each([undefined, "steer"] as const)(
  "keeps ordinary active-run sends when session control is denied (mode %s)",
  async (mode) => {
    vi.mocked(resolveActiveEmbeddedRunSessionId).mockClear();
    vi.mocked(queueEmbeddedAgentMessageWithOutcomeAsync).mockClear();
    vi.mocked(queueGuardedEmbeddedAgentMessageWithOutcomeAsync).mockClear();
    vi.mocked(prepareSessionToolControlTarget).mockClear();
    const result = await startSessionsSendAgentRun({
      cfg: {} as OpenClawConfig,
      callGateway: vi.fn(),
      runId: "send-run",
      sendParams: {
        message: "Continue work",
        agentId: "main",
        inputProvenance: { kind: "inter_session", sourceSessionKey: "agent:main:main" },
        sourceReplyDeliveryMode: "message_tool_only",
      },
      sessionKey: "agent:main:cron:task:run:active",
      sessionStoreTarget: {
        agentId: "main",
        canonicalKey: "agent:main:cron:task:run:active",
        storePath: "/tmp/sessions.json",
      },
      allowActiveRunQueueDelivery: true,
      restrictSessionControls: true,
      mode,
    });

    if (mode === "steer") {
      expect(result).toMatchObject({
        ok: false,
        result: { details: { status: "error", error: "session control denied" } },
      });
      expect(prepareSessionToolControlTarget).toHaveBeenCalledOnce();
      expect(queueGuardedEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
      expect(queueEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
    } else {
      expect(result).toMatchObject({ ok: true, targetDisposition: "steered" });
      expect(prepareSessionToolControlTarget).not.toHaveBeenCalled();
      expect(queueEmbeddedAgentMessageWithOutcomeAsync).toHaveBeenCalledOnce();
      expect(queueGuardedEmbeddedAgentMessageWithOutcomeAsync).not.toHaveBeenCalled();
    }
  },
);
