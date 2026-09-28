import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as reactions from "../../config/sessions/session-reactions.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { mergeProfiles, setDisplayName, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

async function rpc(
  context: GatewayRequestContext,
  client: GatewayClient,
  method: string,
  params: Record<string, unknown>,
) {
  const respond = vi.fn<RespondFn>();
  await handleGatewayRequest({
    req: { type: "req", id: "reaction-proof", method, params },
    respond,
    client,
    isWebchatConnect: () => true,
    context,
  });
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "reaction response");
}

describe("registered human chat reactions", () => {
  it("persists concurrent human reactions without transcript writes, denies impersonation and revoked viewers", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = rolePolicyConfig();
      cfg.agents = {
        ...cfg.agents,
        entries: { ...cfg.agents?.entries, main: { identity: { name: "Reaction Agent" } } },
      };
      await state.writeConfig(cfg);
      const owner = roleClient("write", "reaction-owner");
      const collaborator = roleClient("write", "reaction-collaborator");
      const viewer = roleClient("view", "reaction-viewer");
      const alias = roleClient("write", "reaction-alias");
      const ownerId = expectDefined(owner.authenticatedUserProfile, "owner").profileId;
      const collaboratorId = expectDefined(
        collaborator.authenticatedUserProfile,
        "collaborator",
      ).profileId;
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:reaction-proof",
        sessionId: "reaction-proof",
      };
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      for (const role of ["user", "assistant"] as const) {
        await appendTranscriptMessage(scope, {
          eventId: role,
          message: { role, content: "Saved native message" },
        });
      }
      await appendTranscriptMessage(scope, {
        eventId: "tool",
        message: { role: "toolResult", content: "Tool output" },
      });
      const before = await loadTranscriptEvents(scope);
      const broadcast = vi.fn();
      const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg, broadcast });
      const target = { sessionKey: scope.sessionKey, sessionId: scope.sessionId };
      const set = { ...target, messageId: "assistant", emoji: "👍", active: true };
      const [first, second] = await Promise.all([
        rpc(context, owner, "chat.reactions.set", set),
        rpc(context, collaborator, "chat.reactions.set", set),
      ]);
      expect(first.slice(0, 2)).toEqual([true, { ok: true, changed: true }]);
      expect(second.slice(0, 2)).toEqual([true, { ok: true, changed: true }]);
      expect((await rpc(context, owner, "chat.reactions.set", set)).slice(0, 2)).toEqual([
        true,
        { ok: true, changed: false },
      ]);
      expect(
        broadcast.mock.calls.filter(([event]) => event === "chat.reactions.changed"),
      ).toHaveLength(2);
      expect(broadcast).toHaveBeenCalledWith(
        "chat.reactions.changed",
        {
          ...target,
          agentId: "main",
          messageIds: ["assistant"],
        },
        expect.objectContaining({ sessionKeys: [scope.sessionKey], agentId: "main" }),
      );
      const listed = await rpc(context, viewer, "chat.reactions.list", {
        ...target,
        messageIds: ["assistant", "user"],
      });
      expect(listed[0]).toBe(true);
      expect(listed[1]).toMatchObject({
        sessionId: scope.sessionId,
        messages: [
          {
            messageId: "assistant",
            reactions: [
              {
                emoji: "👍",
                count: 2,
                reactedByMe: false,
                reactors: expect.arrayContaining([
                  expect.objectContaining({ identity: { type: "profile", id: ownerId } }),
                  expect.objectContaining({ identity: { type: "profile", id: collaboratorId } }),
                ]),
                hasMoreReactors: false,
              },
            ],
          },
          { messageId: "user", reactions: [] },
        ],
      });
      expect((await rpc(context, viewer, "chat.reactions.set", set))[0]).toBe(false);
      expect(
        (await rpc(context, owner, "chat.reactions.set", { ...set, profileId: collaboratorId }))[0],
      ).toBe(false);
      for (const extra of [
        { reactor: { type: "agent", id: "main" } },
        { identity: { type: "agent", id: "main" } },
      ]) {
        expect((await rpc(context, owner, "chat.reactions.set", { ...set, ...extra }))[0]).toBe(
          false,
        );
      }
      // Agent authority is tested at its separate entrypoint; this seeds the shared store to
      // exercise typed presentation through the registered human readers and removal handler.
      const agentReaction = {
        sessionId: scope.sessionId,
        messageId: "assistant",
        emoji: "👍",
        active: true,
        reactor: { type: "agent" as const, id: "main" },
        profileAliases: [],
      };
      await reactions.setSessionReaction(scope, agentReaction, () => undefined);
      const mixed = await rpc(context, viewer, "chat.reactions.list", {
        ...target,
        messageIds: ["assistant"],
      });
      expect(mixed[1]).toMatchObject({
        messages: [
          {
            reactions: [
              {
                count: 3,
                reactedByMe: false,
                reactors: expect.arrayContaining([
                  expect.objectContaining({
                    identity: { type: "agent", id: "main" },
                    label: "Reaction Agent",
                  }),
                ]),
              },
            ],
          },
        ],
      });
      expect(
        (
          await rpc(context, owner, "chat.reactions.people", {
            ...target,
            messageId: "assistant",
            emoji: "👍",
          })
        )[1],
      ).toMatchObject({
        reactors: expect.arrayContaining([
          expect.objectContaining({
            identity: { type: "agent", id: "main" },
            label: "Reaction Agent",
          }),
        ]),
      });
      expect((await rpc(context, owner, "chat.reactions.set", { ...set, active: false }))[0]).toBe(
        true,
      );
      expect(
        (
          await rpc(context, owner, "chat.reactions.list", { ...target, messageIds: ["assistant"] })
        )[1],
      ).toMatchObject({
        messages: [
          {
            reactions: [
              {
                count: 2,
                reactedByMe: false,
                reactors: expect.arrayContaining([
                  expect.objectContaining({
                    identity: { type: "agent", id: "main" },
                    label: "Reaction Agent",
                  }),
                ]),
              },
            ],
          },
        ],
      });
      await reactions.setSessionReaction(
        scope,
        { ...agentReaction, active: false },
        () => undefined,
      );
      expect((await rpc(context, owner, "chat.reactions.set", set))[0]).toBe(true);
      const synthetic: GatewayClient = {
        ...owner,
        internal: { ...owner.internal, syntheticClient: true },
      };
      expect((await rpc(context, synthetic, "chat.reactions.set", set))[0]).toBe(false);
      for (const messageId of ["pending:not-saved", "stream-only", "tool"]) {
        expect((await rpc(context, owner, "chat.reactions.set", { ...set, messageId }))[0]).toBe(
          false,
        );
      }
      for (const emoji of ["not emoji", "👍👍", "1"]) {
        expect((await rpc(context, owner, "chat.reactions.set", { ...set, emoji }))[0]).toBe(false);
      }
      expect(
        (await rpc(context, owner, "chat.reactions.set", { ...set, sessionId: "old-session" }))[0],
      ).toBe(false);
      expect(
        (
          await rpc(context, collaborator, "chat.reactions.people", {
            ...target,
            messageId: "assistant",
            emoji: "👍",
          })
        )[1],
      ).toMatchObject({
        reactors: expect.arrayContaining([
          expect.objectContaining({ identity: { type: "profile", id: ownerId } }),
          expect.objectContaining({ identity: { type: "profile", id: collaboratorId } }),
        ]),
      });
      expect(
        (await rpc(context, collaborator, "chat.reactions.set", { ...set, active: false }))[0],
      ).toBe(true);
      expect(
        (
          await rpc(context, owner, "chat.reactions.list", { ...target, messageIds: ["assistant"] })
        )[1],
      ).toMatchObject({
        messages: [{ reactions: [{ count: 1, reactedByMe: true }] }],
      });
      const userReaction = { ...set, messageId: "user" };
      expect((await rpc(context, alias, "chat.reactions.set", userReaction))[0]).toBe(true);
      expect((await rpc(context, owner, "chat.reactions.set", userReaction))[0]).toBe(true);
      mergeProfiles(expectDefined(alias.authenticatedUserProfile, "alias").profileId, ownerId);
      expect(
        (await rpc(context, owner, "chat.reactions.list", { ...target, messageIds: ["user"] }))[1],
      ).toMatchObject({
        messages: [
          {
            reactions: [
              {
                count: 1,
                reactedByMe: true,
                reactors: [expect.objectContaining({ identity: { type: "profile", id: ownerId } })],
              },
            ],
          },
        ],
      });
      expect(
        (await rpc(context, owner, "chat.reactions.set", { ...userReaction, active: false }))[0],
      ).toBe(true);
      expect(
        (await rpc(context, owner, "chat.reactions.list", { ...target, messageIds: ["user"] }))[1],
      ).toMatchObject({ messages: [{ reactions: [] }] });
      await patchSessionEntryCore(scope, () => ({ archivedAt: Date.now() }));
      expect(
        (
          await rpc(context, owner, "chat.reactions.list", { ...target, messageIds: ["assistant"] })
        )[1],
      ).toMatchObject({
        messages: [{ reactions: [{ count: 1 }] }],
      });
      const originalSet = reactions.setSessionReaction;
      const unrelated = vi
        .spyOn(reactions, "setSessionReaction")
        .mockImplementationOnce(async (targetScope, input, assertCurrent) => {
          await withGatewayToolCallerIdentity(
            { agentId: "other", sessionKey: "agent:other:unrelated" },
            () => {
              sessionChanges.emit({ all: true, scope: "agent-runs" });
            },
          );
          setDisplayName(
            expectDefined(viewer.authenticatedUserProfile, "viewer").profileId,
            "Renamed viewer",
          );
          return originalSet(targetScope, input, assertCurrent);
        });
      try {
        expect((await rpc(context, owner, "chat.reactions.set", { ...set, emoji: "🎉" }))[0]).toBe(
          true,
        );
      } finally {
        unrelated.mockRestore();
      }
      expect(
        (
          await rpc(context, owner, "chat.reactions.set", { ...set, emoji: "🎉", active: false })
        )[0],
      ).toBe(true);
      const delayed = vi
        .spyOn(reactions, "setSessionReaction")
        .mockImplementationOnce(async (targetScope, input, assertCurrent) => {
          setUserProfileRole(collaboratorId, "view");
          return originalSet(targetScope, input, assertCurrent);
        });
      try {
        expect(
          (await rpc(context, collaborator, "chat.reactions.set", { ...set, emoji: "❤️" }))[0],
        ).toBe(false);
      } finally {
        delayed.mockRestore();
      }
      expect(
        (
          await rpc(context, owner, "chat.reactions.list", { ...target, messageIds: ["assistant"] })
        )[1],
      ).toMatchObject({
        messages: [{ reactions: [{ emoji: "👍", count: 1 }] }],
      });
      await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
      expect(
        (
          await rpc(context, viewer, "chat.reactions.list", {
            ...target,
            messageIds: ["assistant"],
          })
        )[0],
      ).toBe(false);
      await upsertSessionEntryCore(scope, {
        sessionId: "reaction-next",
        updatedAt: 2,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerId },
      });
      expect(
        (
          await rpc(context, viewer, "chat.reactions.list", {
            ...target,
            messageIds: ["assistant"],
          })
        )[1],
      ).toMatchObject({ messages: [{ reactions: [{ emoji: "👍", count: 1 }] }] });
      expect((await rpc(context, owner, "chat.reactions.set", set))[0]).toBe(false);
      expect(await loadTranscriptEvents(scope)).toEqual(before);
    });
  });
});
