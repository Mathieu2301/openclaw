import fs from "node:fs";
import type { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import {
  rewindSessionToMessage,
  forkSessionAtMessage,
  switchSessionBranch,
} from "./session-accessor.sqlite-message-cut.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  listSessionReactions,
  peopleSessionReactions,
  setSessionReaction,
} from "./session-reactions.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const events = [
  { type: "session", id: "reactions", version: 3 },
  {
    type: "message",
    id: "question",
    parentId: null,
    timestamp: 1,
    message: { role: "user", content: "Question" },
  },
  {
    type: "message",
    id: "answer",
    parentId: "question",
    timestamp: 2,
    message: { role: "assistant", content: "Answer" },
  },
  {
    type: "message",
    id: "tool",
    parentId: "answer",
    timestamp: 3,
    message: { role: "toolResult", content: "Tool result" },
  },
];
const active = (profileId: string, messageId = "answer") => ({
  sessionId: "reactions",
  messageId,
  emoji: "👍",
  reactor: { type: "profile" as const, id: profileId },
  profileAliases: [profileId],
  active: true,
});
const agentActive = (id: string, messageId = "answer") => ({
  ...active(id, messageId),
  reactor: { type: "agent" as const, id },
  profileAliases: [],
});
const list = {
  sessionId: "reactions",
  messageIds: ["question", "answer"],
  profileAliases: {},
  viewerProfileId: "alice",
};
const guard = () => undefined;
afterEach(() => vi.restoreAllMocks());

it("commits concurrent desired states in the worker, dedupes merges, bounds pages, and refuses unsaved identities", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:reactions", sessionId: "reactions" };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, events);
    await Promise.all([
      setSessionReaction(scope, active("alice"), guard),
      setSessionReaction(scope, active("bob"), guard),
      setSessionReaction(scope, active("alice"), guard),
    ]);
    expect(await listSessionReactions(scope, list)).toEqual([
      { messageId: "question", reactions: [] },
      {
        messageId: "answer",
        reactions: [
          {
            emoji: "👍",
            count: 2,
            reactedByMe: true,
            reactors: [
              { type: "profile", id: "alice" },
              { type: "profile", id: "bob" },
            ],
            hasMoreReactors: false,
          },
        ],
      },
    ]);
    expect(await setSessionReaction(scope, active("alice"), guard)).toBe(false);
    await expect(
      setSessionReaction(scope, { ...agentActive("main"), emoji: "👍👍" }, guard),
    ).rejects.toThrow("Choose one emoji");
    await setSessionReaction(scope, active("alice-old"), guard);
    const merged = { ...list, profileAliases: { "alice-old": "alice" } };
    expect((await listSessionReactions(scope, merged))[1]?.reactions[0]?.count).toBe(2);
    expect(
      await setSessionReaction(
        scope,
        { ...active("alice"), profileAliases: ["alice", "alice-old"], active: false },
        guard,
      ),
    ).toBe(true);
    expect(await setSessionReaction(scope, { ...active("alice"), active: false }, guard)).toBe(
      false,
    );
    for (const messageId of ["tool", "pending:turn", "stream-only", "reactions"]) {
      await expect(setSessionReaction(scope, active("alice", messageId), guard)).rejects.toThrow(
        "saved user or assistant",
      );
    }
    await expect(
      setSessionReaction({ ...scope, sessionKey: "agent:main:another" }, active("alice"), guard),
    ).rejects.toThrow("no longer available");
    let current = true;
    const pending = setSessionReaction(scope, active("revoked"), () => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    current = false;
    await expect(pending).rejects.toThrow("revoked");
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let commitAttempted = false;
    const admissionSpy = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            commitAttempted = true;
            current = false;
          }
          admit(request, grant);
        }, attachment),
      );
    current = true;
    try {
      await expect(
        setSessionReaction(scope, agentActive("commit-revoked"), () => {
          if (!current) {
            throw new Error("revoked at commit");
          }
        }),
      ).rejects.toThrow("revoked at commit");
      expect(commitAttempted).toBe(true);
    } finally {
      admissionSpy.mockRestore();
    }
    expect(
      (
        await peopleSessionReactions(scope, {
          sessionId: scope.sessionId,
          messageId: "answer",
          emoji: "👍",
          profileAliases: {},
        })
      ).reactors,
    ).toEqual([{ type: "profile", id: "bob" }]);

    await setSessionReaction(scope, active("alice"), guard);
    await setSessionReaction(scope, active("alice-old"), guard);
    await setSessionReaction(scope, agentActive("alice"), guard);
    await setSessionReaction(scope, agentActive("alice-old"), guard);
    expect((await listSessionReactions(scope, merged))[1]?.reactions[0]).toMatchObject({
      count: 4,
      reactedByMe: true,
      hasMoreReactors: true,
      reactors: [
        { type: "agent", id: "alice" },
        { type: "agent", id: "alice-old" },
        { type: "profile", id: "alice" },
      ],
    });
    // Human alias removal cannot erase the same agent IDs.
    await setSessionReaction(
      scope,
      { ...active("alice"), profileAliases: ["alice-old"], active: false },
      guard,
    );
    expect((await listSessionReactions(scope, merged))[1]?.reactions[0]).toMatchObject({
      count: 3,
      reactedByMe: false,
    });
    await setSessionReaction(scope, active("alice"), guard);
    // Agent writes ignore human aliases and never remove another agent's reaction.
    await setSessionReaction(
      scope,
      { ...agentActive("alice"), profileAliases: ["alice-old", "bob"], active: false },
      guard,
    );
    expect(
      (
        await peopleSessionReactions(scope, {
          sessionId: scope.sessionId,
          messageId: "answer",
          emoji: "👍",
          profileAliases: {},
        })
      ).reactors,
    ).toEqual([
      { type: "agent", id: "alice-old" },
      { type: "profile", id: "alice" },
      { type: "profile", id: "bob" },
    ]);
    await setSessionReaction(scope, { ...agentActive("alice-old"), active: false }, guard);
    await setSessionReaction(scope, { ...active("alice"), active: false }, guard);

    // A single fixture transaction seeds a large people page; runtime reads still use real workers.
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .insertInto("session_message_reactions")
            .values(
              Array.from({ length: 52 }, (_, i) => ({
                session_id: "reactions",
                message_id: "answer",
                emoji: "👍",
                actor_type: i < 50 ? "agent" : "profile",
                actor_id: "person-" + String(i % 50).padStart(2, "0"),
              })),
            ),
        );
      },
      { agentId: "main" },
    );
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    const reads = (["all", "get", "iterate", "run"] as const).map((method) =>
      vi.spyOn(prototype, method),
    );
    try {
      const summary = (await listSessionReactions(scope, list))[1]?.reactions[0];
      expect(summary).toMatchObject({ count: 53, hasMoreReactors: true, reactedByMe: false });
      expect(summary?.reactors).toHaveLength(3);
      const first = await peopleSessionReactions(scope, {
        sessionId: scope.sessionId,
        messageId: "answer",
        emoji: "👍",
        profileAliases: {},
      });
      expect(first.reactors).toHaveLength(50);
      const second = await peopleSessionReactions(scope, {
        sessionId: scope.sessionId,
        messageId: "answer",
        emoji: "👍",
        profileAliases: {},
        cursor: first.nextCursor,
      });
      expect(second.reactors).toHaveLength(3);
      expect(second.nextCursor).toBeUndefined();
      expect(first.reactors.every((identity) => identity.type === "agent")).toBe(true);
      expect(second.reactors.every((identity) => identity.type === "profile")).toBe(true);
      expect(
        new Set([...first.reactors, ...second.reactors].map((identity) => JSON.stringify(identity)))
          .size,
      ).toBe(53);
      expect(
        reads
          .flatMap((spy) => spy.mock.contexts)
          .map((statement) => (statement as StatementSync).sourceSQL)
          .filter((query) => query.includes("session_message_reactions")),
      ).toEqual([]);
    } finally {
      for (const read of reads) {
        read.mockRestore();
      }
    }

    await expect(
      peopleSessionReactions(scope, {
        sessionId: scope.sessionId,
        messageId: "answer",
        emoji: "👍",
        profileAliases: {},
        cursor: "not-a-cursor",
      }),
    ).rejects.toThrow("Invalid reaction people cursor");

    // Reusing an ID does not make a replacement tool event eligible for reactions.
    await replaceTranscriptEvents(
      scope,
      events.map((event) =>
        event.id === "answer"
          ? { ...event, message: { role: "toolResult", content: "Replacement tool output" } }
          : event,
      ),
    );
    expect((await listSessionReactions(scope, list))[1]?.reactions).toEqual([]);
    expect(
      await peopleSessionReactions(scope, {
        sessionId: scope.sessionId,
        messageId: "answer",
        emoji: "👍",
        profileAliases: {},
      }),
    ).toEqual({ reactors: [] });
  });
});

it("preserves retained messages through rewrites and cold storage, starts forks fresh, and deletes permanently", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:reactions", sessionId: "reactions" };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, events);
    await setSessionReaction(scope, active("alice", "question"), guard);
    await setSessionReaction(scope, agentActive("bob"), guard);
    await replaceTranscriptEvents(scope, events.slice(0, 2));
    expect(
      (await listSessionReactions(scope, list)).map((message) => message.reactions.length),
    ).toEqual([1, 0]);
    await replaceTranscriptEvents(scope, events);
    expect((await listSessionReactions(scope, list))[1]?.reactions).toEqual([]);
    const fork = { ...scope, sessionId: "fork", sessionKey: "agent:main:fork" };
    await replaceSessionEntry(fork, { sessionId: fork.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(fork, [{ ...events[0], id: "fork" }, ...events.slice(1)]);
    expect(
      (await listSessionReactions(fork, { ...list, sessionId: fork.sessionId })).every(
        (message) => message.reactions.length === 0,
      ),
    ).toBe(true);
    await waitForSessionTranscriptIndexReconcile({ agentId: "main" });
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    runOpenClawAgentWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("session_windows")
            .set({ updated_at: 1, transcript_updated_at: 1 })
            .where("session_id", "=", scope.sessionId),
        );
      },
      { agentId: "main" },
    );
    await runSessionColdStorageMaintenance({
      config: {
        agents: { list: [{ id: "main" }] },
        session: {
          store: database.path,
          maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
        },
      },
    });
    expect(
      database.db
        .prepare("SELECT 1 FROM session_transcript_cold_archives WHERE session_id = ?")
        .get(scope.sessionId),
    ).toBeTruthy();
    // A downgraded writer can leave companion rows for IDs absent from its cold archive.
    database.db
      .prepare("INSERT INTO session_message_reactions VALUES (?, ?, ?, ?, ?)")
      .run(scope.sessionId, "orphan", "👍", "agent", "ghost");
    expect(
      (await listSessionReactions(scope, { ...list, messageIds: ["orphan"] }))[0]?.reactions,
    ).toEqual([]);
    expect(
      await peopleSessionReactions(scope, {
        sessionId: scope.sessionId,
        messageId: "orphan",
        emoji: "👍",
        profileAliases: {},
      }),
    ).toEqual({ reactors: [] });
    expect((await listSessionReactions(scope, list))[0]?.reactions[0]?.count).toBe(1);
    await setSessionReaction(scope, agentActive("bob", "question"), guard);
    expect((await listSessionReactions(scope, list))[0]?.reactions[0]?.reactors).toEqual([
      { type: "agent", id: "bob" },
      { type: "profile", id: "alice" },
    ]);
    expect(
      database.db
        .prepare("SELECT 1 FROM session_message_reactions WHERE message_id = 'orphan'")
        .get(),
    ).toBeUndefined();
    expect((await listSessionReactions(scope, list))[0]?.reactions[0]?.count).toBe(2);
    const removed = await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: database.path,
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      archiveTranscript: true,
    });
    expect(removed.deleted).toBe(true);
    database.db
      .prepare("INSERT INTO session_message_reactions VALUES (?, ?, ?, ?, ?)")
      .run(scope.sessionId, "orphan", "👍", "agent", "ghost");
    expect(
      (await listSessionReactions(scope, { ...list, messageIds: ["orphan"] }))[0]?.reactions,
    ).toEqual([]);
    expect((await listSessionReactions(scope, list))[0]?.reactions[0]?.count).toBe(2);
    await withSqliteSessionPageReclamation(
      { agentId: "main", path: database.path },
      async (_reclaim, _assert, _options, archives) => {
        await archives.withWriter(async () => {
          const archive = await archives.read();
          if (!archive) {
            throw new Error("missing retained archive");
          }
          await archives.deletePublished(archive);
        });
      },
    );
    expect(database.db.prepare("SELECT * FROM session_message_reactions").all()).toEqual([]);
  });
});

it("keeps incognito reactions only in its existing ephemeral database", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:incognito-reactions",
      sessionId: "reactions",
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1, incognito: true });
    await replaceTranscriptEvents(scope, events);
    await setSessionReaction(scope, active("alice"), guard);
    expect((await listSessionReactions(scope, list))[1]?.reactions[0]?.count).toBe(1);
    expect(fs.existsSync(resolveIncognitoOpenClawAgentSqlitePath(scope))).toBe(false);
  });
});

it("retains reactions across real rewind and branch selection, but not a fork", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = { agentId: "main", sessionKey: "agent:main:reactions", sessionId: "reactions" };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, events.slice(0, 3));
    await setSessionReaction(scope, active("alice", "question"), guard);
    await setSessionReaction(scope, agentActive("bob"), guard);
    const rewound = await rewindSessionToMessage({ ...scope, entryId: "question" });
    expect(rewound.status).toBe("created");
    if (rewound.status !== "created") {
      throw new Error("rewind did not commit");
    }
    expect(
      (await listSessionReactions(scope, { ...list, sessionId: rewound.entry.sessionId })).map(
        (message) => message.reactions[0]?.count,
      ),
    ).toEqual([1, 1]);
    const switched = await switchSessionBranch({ ...scope, leafEntryId: "answer" });
    expect(switched.status).toBe("created");
    if (switched.status !== "created") {
      throw new Error("branch did not commit");
    }
    expect(
      (await listSessionReactions(scope, { ...list, sessionId: switched.entry.sessionId })).map(
        (message) => message.reactions[0]?.count,
      ),
    ).toEqual([1, 1]);
    expect(
      (await listSessionReactions(scope, { ...list, sessionId: switched.entry.sessionId }))[1]
        ?.reactions[0]?.reactors,
    ).toEqual([{ type: "agent", id: "bob" }]);
    const forked = await forkSessionAtMessage({
      ...scope,
      entryId: "question",
      targetKey: "agent:main:fork",
    });
    expect(forked.status).toBe("created");
    if (forked.status !== "created") {
      throw new Error("fork did not commit");
    }
    expect(
      (
        await listSessionReactions(
          { ...scope, sessionKey: forked.key },
          { ...list, sessionId: forked.entry.sessionId },
        )
      ).every((message) => message.reactions.length === 0),
    ).toBe(true);
  });
});
