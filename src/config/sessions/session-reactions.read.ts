import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import {
  hashSessionArchiveBytes,
  MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES,
} from "./session-accessor.sqlite-archive-artifact.js";
import { scanArchivedTranscript } from "./session-accessor.sqlite-archive-read.js";
import { MAX_TASK_ARCHIVE_RECORD_BYTES } from "./session-accessor.sqlite-archive-stream.js";
import { MAX_VISIBLE_MESSAGE_MAX_MESSAGES } from "./session-accessor.sqlite-visible-cursor.js";
import {
  decodeSessionColdRecords,
  readVerifiedSessionColdArchive,
} from "./session-cold-storage-codec.js";
import { projectTranscriptPayloadNavigationSql } from "./session-model-context-projection.js";
import {
  listSessionReactionsInDatabase,
  peopleSessionReactionsInDatabase,
  type ListSessionReactionsInput,
  type PeopleSessionReactionsInput,
} from "./session-reactions.kernel.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";

export type SessionReactionQuery =
  | { kind: "list"; input: ListSessionReactionsInput }
  | { kind: "people"; input: PeopleSessionReactionsInput };

/** The history worker retains reactions and their canonical archive bytes from one snapshot. */
export async function readSessionReactionsInWorker(
  options: OpenClawAgentDatabaseOptions,
  sessionKey: string,
  query: SessionReactionQuery,
) {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) =>
      runSqliteDeferredTransactionSync(db, () => {
        const value =
          query.kind === "list"
            ? listSessionReactionsInDatabase(db, sessionKey, query.input)
            : peopleSessionReactionsInDatabase(db, sessionKey, query.input);
        const ids = Array.isArray(value)
          ? value
              .filter((message) => message.reactions.length > 0)
              .map((message) => message.messageId)
          : value.reactors.length > 0 && query.kind === "people"
            ? [query.input.messageId]
            : [];
        const kysely = getNodeSqliteKysely<DB>(db);
        const hotRows = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("transcript_events as event", (join) =>
              join
                .onRef("event.session_id", "=", "identity.session_id")
                .onRef("event.seq", "=", "identity.seq"),
            )
            .select([
              "identity.event_id",
              projectTranscriptPayloadNavigationSql(transcriptEventNavigationSql("event")).as(
                "navigation",
              ),
            ])
            .where("identity.session_id", "=", query.input.sessionId)
            .where("identity.event_id", "in", ids),
        ).rows;
        const hotSeenIds = new Set(hotRows.map((row) => row.event_id));
        const hotIds = new Set(
          hotRows
            .filter((row) => {
              const event: unknown = JSON.parse(row.navigation);
              return (
                isRecord(event) &&
                event.type === "message" &&
                isRecord(event.message) &&
                (event.message.role === "user" || event.message.role === "assistant")
              );
            })
            .map((row) => row.event_id),
        );
        const cold =
          hotSeenIds.size < ids.length
            ? executeSqliteQueryTakeFirstSync(
                db,
                kysely
                  .selectFrom("session_transcript_cold_archives")
                  .selectAll()
                  .where("session_id", "=", query.input.sessionId),
              )
            : undefined;
        const archiveQuery = kysely
          .selectFrom("session_transcript_archives")
          .where("session_id", "=", query.input.sessionId)
          .where("session_key", "=", sessionKey);
        const hasArchives =
          hotSeenIds.size < ids.length &&
          getAdmittedSqliteSchemaFacts(db)?.tables.has("session_transcript_archives");
        const sizing = hasArchives
          ? executeSqliteQueryTakeFirstSync(
              db,
              archiveQuery.select(({ fn }) => [
                fn.countAll<number>().as("count"),
                fn.sum<number>(fn<number>("length", ["archive_blob"])).as("bytes"),
              ]),
            )
          : undefined;
        if (
          sizing &&
          (sizing.count > MAX_VISIBLE_MESSAGE_MAX_MESSAGES ||
            (sizing.bytes ?? 0) > MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES)
        ) {
          throw new Error("Reaction archive candidates exceed the bounded read size");
        }
        const archives = hasArchives
          ? executeSqliteQuerySync(
              db,
              archiveQuery.select(["archive_blob", "archive_sha256", "encoding"]),
            ).rows
          : [];
        return { value, hotIds, hotSeenIds, cold, archives };
      }),
    options,
  );
  if (!result.found) {
    throw new Error("Reaction session database is unavailable");
  }
  const { value, hotIds: validIds, hotSeenIds, cold, archives } = result.value;
  const wanted = new Set(query.kind === "list" ? query.input.messageIds : [query.input.messageId]);
  const accept = (event: unknown) => {
    if (
      isRecord(event) &&
      event.type === "message" &&
      typeof event.id === "string" &&
      wanted.has(event.id) &&
      !hotSeenIds.has(event.id) &&
      isRecord(event.message) &&
      (event.message.role === "user" || event.message.role === "assistant")
    ) {
      validIds.add(event.id);
    }
  };
  if (cold) {
    if (!options.path) {
      throw new Error("Cold reaction read requires its captured physical path");
    }
    const records = decodeSessionColdRecords(
      await readVerifiedSessionColdArchive({ storePath: options.path, archive: cold }),
      cold,
    );
    for (const record of records) {
      if (record.kind === "event") {
        accept(JSON.parse(record.row.event_json));
      }
    }
  }
  const budget = { remainingBytes: MAX_MATERIALIZED_ARCHIVE_BATCH_BYTES };
  for (const archive of archives) {
    if (hashSessionArchiveBytes(archive.archive_blob) !== archive.archive_sha256) {
      throw new Error("Archived transcript bytes do not match their registered hash");
    }
    await scanArchivedTranscript(
      archive.archive_blob,
      archive.encoding === "zstd",
      query.input.sessionId,
      accept,
      budget,
      MAX_TASK_ARCHIVE_RECORD_BYTES,
    );
  }
  // A cold marker is custody, not proof that an arbitrary old reaction ID still exists.
  return Array.isArray(value)
    ? value.map((message) =>
        validIds.has(message.messageId) ? message : { ...message, reactions: [] },
      )
    : validIds.has(query.kind === "people" ? query.input.messageId : "")
      ? value
      : { reactors: [] };
}
