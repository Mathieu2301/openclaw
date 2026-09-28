import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { assertSqliteSchemaContains } from "../../infra/sqlite-schema-contract.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import { AGENT_SCHEMA_COMPATIBILITY } from "../../state/openclaw-agent-db-schema-compatibility.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { listSessionReactions, setSessionReaction } from "./session-reactions.js";

it("admits absent additive storage, preserves old-reader shape, and prunes downgrade orphans on reopen", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:reaction-upgrade",
      sessionId: "upgrade",
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "retained",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "Retained" },
      },
      {
        type: "message",
        id: "removed",
        parentId: "retained",
        timestamp: 2,
        message: { role: "assistant", content: "Removed" },
      },
    ]);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const pathname = database.path;
    const version = database.db.prepare("PRAGMA user_version").get();
    await closeOpenClawAgentDatabasesAsync();
    const older = new DatabaseSync(pathname);
    const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(
      extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, "session_message_reactions"),
      "",
    );
    older.exec("DROP TABLE session_message_reactions");
    assertSqliteSchemaContains(older, pathname, previousSchema, AGENT_SCHEMA_COMPATIBILITY);
    older.close();
    const candidate = openOpenClawAgentDatabase({ agentId: "main" });
    expect(candidate.db.prepare("PRAGMA user_version").get()).toEqual(version);
    for (const messageId of ["retained", "removed"]) {
      for (const type of ["profile", "agent"] as const) {
        await setSessionReaction(
          scope,
          {
            sessionId: scope.sessionId,
            messageId,
            emoji: "👍",
            reactor: { type, id: "human" },
            profileAliases: ["human"],
            active: true,
          },
          () => undefined,
        );
      }
    }
    await closeOpenClawAgentDatabasesAsync();
    const downgraded = new DatabaseSync(pathname);
    assertSqliteSchemaContains(downgraded, pathname, previousSchema, AGENT_SCHEMA_COMPATIBILITY);
    downgraded.exec("PRAGMA foreign_keys = ON");
    downgraded
      .prepare("DELETE FROM transcript_events WHERE session_id = ? AND seq = 2")
      .run(scope.sessionId);
    expect(
      downgraded.prepare("SELECT count(*) AS total FROM session_message_reactions").get(),
    ).toEqual({ total: 4 });
    expect(downgraded.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    downgraded.close();
    const upgraded = openOpenClawAgentDatabase({ agentId: "main" });
    expect(upgraded.db.prepare("PRAGMA user_version").get()).toEqual(version);
    expect(upgraded.db.prepare("SELECT message_id FROM session_message_reactions").all()).toEqual([
      { message_id: "retained" },
      { message_id: "retained" },
    ]);
    expect(
      (
        await listSessionReactions(scope, {
          sessionId: scope.sessionId,
          messageIds: ["retained", "removed"],
          profileAliases: {},
        })
      ).map((message) => message.reactions.length),
    ).toEqual([1, 0]);
    expect(
      (
        await listSessionReactions(scope, {
          sessionId: scope.sessionId,
          messageIds: ["retained"],
          profileAliases: {},
          viewerProfileId: "human",
        })
      )[0]?.reactions[0],
    ).toMatchObject({
      count: 2,
      reactedByMe: true,
      reactors: [
        { type: "agent", id: "human" },
        { type: "profile", id: "human" },
      ],
    });
    expect(() =>
      upgraded.db
        .prepare("INSERT INTO session_message_reactions VALUES (?, ?, ?, ?, ?)")
        .run(scope.sessionId, "retained", "👍", "remote", "human"),
    ).toThrow();
    expect(upgraded.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
