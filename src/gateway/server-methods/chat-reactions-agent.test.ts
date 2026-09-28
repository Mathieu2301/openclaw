import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  upsertSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as reactions from "../../config/sessions/session-reactions.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../gateway/message-action-turn-capability.js";
import { createGatewayMethodRegistry } from "../../gateway/methods/registry.js";
import { handleGatewayRequest } from "../../gateway/server-methods.js";
import { createHistoryReadContext } from "../../gateway/server-methods/chat-history.test-helpers.js";
import { chatReactionHandlers } from "../../gateway/server-methods/chat-reactions.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../../gateway/server-methods/types.js";
import { roleClient, rolePolicyConfig } from "../../gateway/session-sharing.test-utils.js";
import {
  claimAgentRunDelegatedAuthority,
  getActiveAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";

async function rpc(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: "native-reaction-proof", method, params },
    respond,
    client,
    isWebchatConnect: () => true,
    context,
  });
  return expectDefined(respond.mock.calls[0], "reaction RPC response");
}

it.each([false, true])(
  "routes admitted agent reactions without impersonation or transcript writes (incognito: %s)",
  async (incognito) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      if (incognito) {
        expectDefined(cfg.gateway?.roles?.definitions?.write, "incognito admin role").scopes = [
          "operator.admin",
        ];
      }
      cfg.agents = {
        ...cfg.agents,
        entries: { ...cfg.agents?.entries, main: { identity: { name: "Atlas" } } },
      };
      await state.writeConfig(cfg);
      const scope = {
        agentId: "main",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-reaction-proof"
          : "agent:main:native-reaction-proof",
        sessionId: "native-reaction-window",
      };
      const human = roleClient("write", "native-reaction-human");
      if (incognito) {
        human.connect.scopes = ["operator.admin"];
      }
      const writeEntry = incognito ? replaceSessionEntry : upsertSessionEntryCore;
      await writeEntry(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        ...(incognito ? { incognito: true as const } : {}),
        modelSelectionLocked: !incognito,
        visibility: "shared",
        createdActor: {
          type: "human",
          source: "profile",
          id: expectDefined(human.authenticatedUserProfile, "human").profileId,
        },
      });
      for (const role of ["user", "assistant"] as const) {
        await appendTranscriptMessage(scope, {
          eventId: role,
          message: { role, content: "Saved message" },
        });
      }
      const before = await loadTranscriptEvents(scope);
      const broadcast = vi.fn();
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        broadcast,
        validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
      });
      const registry = createGatewayMethodRegistry(
        Object.entries(chatReactionHandlers).map(([name, handler]) => ({
          name,
          handler,
          owner: { kind: "core" as const, area: "chat" },
          scope:
            name === "chat.reactions.set"
              ? ("operator.write" as const)
              : ("operator.read" as const),
        })),
      );
      context.getGatewayMethodRegistry = () => registry;
      const run = createOperationalRunInstanceRef("native-reaction-run");
      const runAuthority = claimAgentRunDelegatedAuthority(run);
      const capability = mintMessageActionTurnCapability({
        agentId: scope.agentId,
        runId: run.runId,
        sessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        toolContext: { currentChannelProvider: "webchat", currentMessageId: "user" },
      });
      const tool = createMessageTool({
        config: cfg,
        agentId: scope.agentId,
        agentSessionKey: scope.sessionKey,
        sessionId: scope.sessionId,
        runId: run.runId,
        currentChannelProvider: "webchat",
        currentMessageId: "user",
        messageActionTurnCapability: capability,
        preparedMessageToolCatalog: { version: 1, channels: [], getChannel: () => undefined },
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config }) => ({
          resolvedConfig: config,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
      });
      const caller = {
        agentId: scope.agentId,
        sessionKey: scope.sessionKey,
        operationalRunInstance: run,
        gatewayContextResolver: () => context,
        receiptAuthority: () => getActiveAgentRunDelegatedAuthority(run) === runAuthority,
        assertToolAllowed: (name: string) => {
          if (name !== "message") {
            throw new Error("Tool is not in this test turn’s admitted tool set");
          }
        },
      };
      const execute = (params: Record<string, unknown>) =>
        withGatewayToolCallerIdentity(caller, () =>
          tool.execute("native-reaction", { action: "react", emoji: "👍", ...params }),
        );
      try {
        const set = { ...scope, messageId: "user", emoji: "👍", active: true };
        const humanAdded = await rpc(context, human, "chat.reactions.set", set);
        expect(humanAdded[0], JSON.stringify(humanAdded)).toBe(true);
        const added = await execute({ final: true });
        expect(added.details).toMatchObject({
          ok: true,
          changed: true,
          messageId: "user",
          messageDelivery: { status: "settled", sourceReplyDelivered: true },
        });
        const repeated = await execute({ final: true });
        expect(repeated.details).toMatchObject({ changed: false });
        expect(repeated.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        const otherMessage = await execute({ messageId: "assistant", final: true });
        expect(otherMessage.details).toMatchObject({ changed: true });
        expect(otherMessage.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        const listed = await rpc(context, human, "chat.reactions.list", {
          ...scope,
          messageIds: ["user", "assistant"],
        });
        expect(listed[1]).toMatchObject({
          messages: [
            {
              messageId: "user",
              reactions: [
                {
                  count: 2,
                  reactedByMe: true,
                  reactors: expect.arrayContaining([
                    expect.objectContaining({
                      identity: { type: "agent", id: "main" },
                      label: "Atlas",
                    }),
                  ]),
                },
              ],
            },
            { messageId: "assistant", reactions: [{ count: 1, reactedByMe: false }] },
          ],
        });
        const removed = await execute({ remove: true, final: true });
        expect(removed.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        expect(
          (await rpc(context, human, "chat.reactions.list", { ...scope, messageIds: ["user"] }))[1],
        ).toMatchObject({ messages: [{ reactions: [{ count: 1, reactedByMe: true }] }] });
        const broadcasts = broadcast.mock.calls.length;
        expect(
          (await execute({ dryRun: true, messageId: "assistant", remove: true })).details,
        ).toMatchObject({ dryRun: true, changed: false });
        expect(broadcast.mock.calls.length).toBe(broadcasts);
        await expect(execute({ messageId: "not-saved" })).rejects.toThrow(/saved|message/i);
        expect(await loadTranscriptEvents(scope)).toEqual(before);
        const gate = createDeferred();
        const entered = createDeferred();
        const originalSet = reactions.setSessionReaction;
        const spy = vi
          .spyOn(reactions, "setSessionReaction")
          .mockImplementationOnce(async (...args) => {
            entered.resolve();
            await gate.promise;
            return originalSet(...args);
          });
        const pending = execute({ emoji: "🎉" });
        const rejected = expect(pending).rejects.toThrow(/authority|active|access/i);
        await entered.promise;
        releaseAgentRunDelegatedAuthority(runAuthority);
        gate.resolve();
        await rejected;
        spy.mockRestore();
        expect(broadcast.mock.calls.length).toBe(broadcasts);
        await expect(execute({})).rejects.toThrow(/authority|active/i);
      } finally {
        revokeMessageActionTurnCapability(capability);
        releaseAgentRunDelegatedAuthority(runAuthority);
        vi.restoreAllMocks();
      }
    });
  },
);
