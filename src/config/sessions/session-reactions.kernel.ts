import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import type { ChatReactionIdentity } from "../../../packages/gateway-protocol/src/chat-reactions.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { assertChatReactionEmoji } from "../../shared/chat-reaction-emoji.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export type SetSessionReactionInput = {
  sessionId: string;
  messageId: string;
  emoji: string;
  reactor: ChatReactionIdentity;
  profileAliases: string[];
  active: boolean;
};
export type ListSessionReactionsInput = {
  sessionId: string;
  messageIds: string[];
  profileAliases: Record<string, string>;
  viewerProfileId?: string;
};
export type SessionReactionSummary = {
  messageId: string;
  reactions: Array<{
    emoji: string;
    count: number;
    reactedByMe: boolean;
    reactors: ChatReactionIdentity[];
    hasMoreReactors: boolean;
  }>;
};
export type PeopleSessionReactionsInput = {
  sessionId: string;
  messageId: string;
  emoji: string;
  profileAliases: Record<string, string>;
  cursor?: string;
};
export type SessionReactionPeople = { reactors: ChatReactionIdentity[]; nextCursor?: string };

function reactorIdentity(row: { actor_type: string; actor_id: string }): ChatReactionIdentity {
  if (row.actor_type !== "profile" && row.actor_type !== "agent") {
    throw new Error("Invalid stored reaction identity");
  }
  return { type: row.actor_type, id: row.actor_id };
}

function decodeCursor(cursor: string): ChatReactionIdentity {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid reaction people cursor");
  }
  if (
    !isRecord(value) ||
    (value.type !== "profile" && value.type !== "agent") ||
    typeof value.id !== "string" ||
    !value.id
  ) {
    throw new Error("Invalid reaction people cursor");
  }
  return { type: value.type, id: value.id };
}

function hasReactions(db: DatabaseSync) {
  const facts = getAdmittedSqliteSchemaFacts(db);
  if (!facts) {
    throw new Error("Reaction reads require admitted schema facts");
  }
  return facts.tables.has("session_message_reactions");
}

function assertWindow(db: DatabaseSync, sessionKey: string, sessionId: string) {
  const window = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DB>(db)
      .selectFrom("session_windows")
      .select("session_id")
      .where("session_id", "=", sessionId)
      .where("session_key", "=", sessionKey),
  );
  if (window) {
    return;
  }
  const archive =
    getAdmittedSqliteSchemaFacts(db)?.tables.has("session_transcript_archives") &&
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("session_transcript_archives")
        .select("session_id")
        .where("session_id", "=", sessionId)
        .where("session_key", "=", sessionKey)
        .limit(1),
    );
  if (!archive) {
    throw new Error("Reaction session is no longer available");
  }
}

/** The committing worker verifies the durable native message, not a UI-provided role or ID. */
export function setSessionReactionInDatabase(
  db: DatabaseSync,
  sessionKey: string,
  input: SetSessionReactionInput,
): boolean {
  assertChatReactionEmoji(input.emoji);
  assertWindow(db, sessionKey, input.sessionId);
  assertSessionTranscriptHot(db, input.sessionId);
  const kysely = getNodeSqliteKysely<DB>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "identity.session_id")
          .onRef("event.seq", "=", "identity.seq"),
      )
      .select(transcriptEventJsonSql(db, "event").as("event_json"))
      .where("identity.session_id", "=", input.sessionId)
      .where("identity.event_id", "=", input.messageId),
  );
  const event: unknown = row ? JSON.parse(row.event_json) : undefined;
  if (
    !isRecord(event) ||
    event.type !== "message" ||
    !isRecord(event.message) ||
    !["user", "assistant"].includes(String(event.message.role))
  ) {
    throw new Error("Reactions require a saved user or assistant message");
  }
  const aliases =
    input.reactor.type === "profile"
      ? [...new Set([input.reactor.id, ...input.profileAliases])]
      : [input.reactor.id];
  const existing = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("session_message_reactions")
      .select("actor_id")
      .where("session_id", "=", input.sessionId)
      .where("message_id", "=", input.messageId)
      .where("emoji", "=", input.emoji)
      .where("actor_type", "=", input.reactor.type)
      .where("actor_id", "in", aliases),
  ).rows;
  if (input.active && existing.length === 1 && existing[0]?.actor_id === input.reactor.id) {
    return false;
  }
  if (!input.active && existing.length === 0) {
    return false;
  }
  if (input.active && existing.length === 0) {
    const emojis = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("session_message_reactions")
        .select("emoji")
        .distinct()
        .where("session_id", "=", input.sessionId)
        .where("message_id", "=", input.messageId)
        .limit(64),
    ).rows;
    if (emojis.length >= 64 && !emojis.some((reaction) => reaction.emoji === input.emoji)) {
      throw new Error("A message supports at most 64 different reactions");
    }
  }
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_message_reactions")
      .where("session_id", "=", input.sessionId)
      .where("message_id", "=", input.messageId)
      .where("emoji", "=", input.emoji)
      .where("actor_type", "=", input.reactor.type)
      .where("actor_id", "in", aliases),
  );
  if (input.active) {
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("session_message_reactions")
        .values({
          session_id: input.sessionId,
          message_id: input.messageId,
          emoji: input.emoji,
          actor_type: input.reactor.type,
          actor_id: input.reactor.id,
        })
        .onConflict((conflict) => conflict.doNothing()),
    );
  }
  return existing.length === 0 || !input.active;
}

function canonicalReactors(
  db: DatabaseSync,
  sessionId: string,
  messageIds: string[],
  aliases: Record<string, string>,
) {
  const kysely = getNodeSqliteKysely<DB>(db);
  return kysely.with("reactors", (query) =>
    query
      .selectFrom("session_message_reactions as reaction")
      .leftJoin(
        sql<{ key: string; value: string }>`json_each(${JSON.stringify(aliases)})`.as("alias"),
        (join) =>
          join
            .onRef("alias.key", "=", "reaction.actor_id")
            .on("reaction.actor_type", "=", "profile"),
      )
      .select([
        "reaction.message_id",
        "reaction.emoji",
        "reaction.actor_type",
        sql<string>`coalesce(alias.value, reaction.actor_id)`.as("actor_id"),
      ])
      .where("reaction.session_id", "=", sessionId)
      .where("reaction.message_id", "in", messageIds)
      .where((eb) =>
        eb.or([
          ...(getAdmittedSqliteSchemaFacts(db)?.tables.has("session_transcript_archives")
            ? [
                eb.exists(
                  eb
                    .selectFrom("session_transcript_archives as archive")
                    .select("archive.session_id")
                    .whereRef("archive.session_id", "=", "reaction.session_id"),
                ),
              ]
            : []),
          eb.exists(
            eb
              .selectFrom("transcript_event_identities as identity")
              .select("identity.event_id")
              .whereRef("identity.session_id", "=", "reaction.session_id")
              .whereRef("identity.event_id", "=", "reaction.message_id"),
          ),
          eb.exists(
            eb
              .selectFrom("session_transcript_cold_archives as cold")
              .select("cold.session_id")
              .whereRef("cold.session_id", "=", "reaction.session_id"),
          ),
        ]),
      )
      .distinct(),
  );
}

export function listSessionReactionsInDatabase(
  db: DatabaseSync,
  sessionKey: string,
  input: ListSessionReactionsInput,
): SessionReactionSummary[] {
  if (input.messageIds.length > 100) {
    throw new Error("Reaction reads support at most 100 messages");
  }
  const messages: SessionReactionSummary[] = [...new Set(input.messageIds)].map((messageId) => ({
    messageId,
    reactions: [],
  }));
  assertWindow(db, sessionKey, input.sessionId);
  if (messages.length === 0 || !hasReactions(db)) {
    return messages;
  }
  const rows = executeSqliteQuerySync(
    db,
    canonicalReactors(db, input.sessionId, input.messageIds, input.profileAliases)
      .with("ranked", (query) =>
        query
          .selectFrom("reactors")
          .selectAll()
          .select([
            sql<number>`row_number() over (partition by message_id, emoji order by actor_type, actor_id)`.as(
              "rank",
            ),
            sql<number>`count(*) over (partition by message_id, emoji)`.as("count"),
            sql<number>`max(case when actor_type = 'profile' and actor_id = ${input.viewerProfileId ?? ""} then 1 else 0 end) over (partition by message_id, emoji)`.as(
              "mine",
            ),
          ]),
      )
      .selectFrom("ranked")
      .selectAll()
      .where("rank", "<=", 3)
      .orderBy("message_id")
      .orderBy("emoji")
      .orderBy("actor_type")
      .orderBy("actor_id")
      .limit(100 * 64 * 3 + 1),
  ).rows;
  if (rows.length > 100 * 64 * 3) {
    throw new Error("Reaction summary exceeds its read budget");
  }
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  for (const row of rows) {
    const message = byId.get(row.message_id)!;
    let reaction = message.reactions.at(-1);
    if (reaction?.emoji !== row.emoji) {
      reaction = {
        emoji: row.emoji,
        count: row.count,
        reactedByMe: row.mine === 1,
        reactors: [],
        hasMoreReactors: row.count > 3,
      };
      message.reactions.push(reaction);
    }
    reaction.reactors.push(reactorIdentity(row));
  }
  return messages;
}

export function peopleSessionReactionsInDatabase(
  db: DatabaseSync,
  sessionKey: string,
  input: PeopleSessionReactionsInput,
): SessionReactionPeople {
  assertWindow(db, sessionKey, input.sessionId);
  if (!hasReactions(db)) {
    return { reactors: [] };
  }
  const after = input.cursor ? decodeCursor(input.cursor) : undefined;
  const rows = executeSqliteQuerySync(
    db,
    canonicalReactors(db, input.sessionId, [input.messageId], input.profileAliases)
      .selectFrom("reactors")
      .select(["actor_type", "actor_id"])
      .where("emoji", "=", input.emoji)
      .$if(after !== undefined, (query) =>
        query.where((eb) =>
          eb.or([
            eb("actor_type", ">", after!.type),
            eb.and([eb("actor_type", "=", after!.type), eb("actor_id", ">", after!.id)]),
          ]),
        ),
      )
      .orderBy("actor_type")
      .orderBy("actor_id")
      .limit(51),
  ).rows;
  const reactors = rows.slice(0, 50).map(reactorIdentity);
  return {
    reactors,
    ...(rows.length > 50
      ? { nextCursor: Buffer.from(JSON.stringify(reactors.at(-1)!)).toString("base64url") }
      : {}),
  };
}

/** Rewind and branch selection rotate physical windows, but retain the same saved messages. */
export function copySessionReactionsInTransaction(
  db: DatabaseSync,
  sourceId: string,
  destinationId: string,
): void {
  if (!hasReactions(db)) {
    return;
  }
  const kysely = getNodeSqliteKysely<DB>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("session_message_reactions")
      .columns(["session_id", "message_id", "emoji", "actor_type", "actor_id"])
      .expression(
        kysely
          .selectFrom("session_message_reactions as reaction")
          .innerJoin("transcript_event_identities as identity", (join) =>
            join
              .on("identity.session_id", "=", destinationId)
              .onRef("identity.event_id", "=", "reaction.message_id"),
          )
          .select([
            sql<string>`${destinationId}`.as("session_id"),
            "reaction.message_id",
            "reaction.emoji",
            "reaction.actor_type",
            "reaction.actor_id",
          ])
          .where("reaction.session_id", "=", sourceId),
      )
      .onConflict((conflict) => conflict.doNothing()),
  );
}

/** Called after replacement or final archive deletion; retained canonical history keeps custody. */
export function pruneSessionReactionsInTransaction(db: DatabaseSync, sessionId?: string): void {
  if (!hasReactions(db)) {
    return;
  }
  const kysely = getNodeSqliteKysely<DB>(db);
  const archives =
    getAdmittedSqliteSchemaFacts(db)?.tables.has("session_transcript_archives") === true;
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("session_message_reactions")
      .$if(sessionId !== undefined, (query) => query.where("session_id", "=", sessionId!))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("transcript_event_identities as identity")
              .select("identity.event_id")
              .whereRef("identity.session_id", "=", "session_message_reactions.session_id")
              .whereRef("identity.event_id", "=", "session_message_reactions.message_id"),
          ),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("session_transcript_cold_archives as cold")
              .select("cold.session_id")
              .whereRef("cold.session_id", "=", "session_message_reactions.session_id"),
          ),
        ),
      )
      .$if(archives, (query) =>
        query.where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("session_transcript_archives as archive")
                .select("archive.session_id")
                .whereRef("archive.session_id", "=", "session_message_reactions.session_id"),
            ),
          ),
        ),
      ),
  );
}
