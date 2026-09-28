import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { restoreSessionColdTranscript } from "./session-cold-storage.js";
import {
  setSessionReactionInDatabase,
  type SetSessionReactionInput,
  type ListSessionReactionsInput,
  type PeopleSessionReactionsInput,
} from "./session-reactions.kernel.js";
import {
  readSessionReactionsInWorker,
  type SessionReactionQuery,
} from "./session-reactions.read.js";
import { runSessionCollaborationWrite } from "./session-sharing-store.async.js";
import { projectionLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

function captureScope(scope: SessionAccessScope) {
  const env = { ...(scope.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteScope({ ...scope, env });
  const databaseOptions = toDatabaseOptions(resolved);
  const options = { ...databaseOptions, path: resolveOpenClawAgentSqlitePath(databaseOptions) };
  return {
    options,
    env,
    sessionKey: resolved.sessionKey,
    scope: { ...scope, env, storePath: options.path },
  };
}

async function readReactions(scope: SessionAccessScope, query: SessionReactionQuery) {
  const captured = captureScope(scope);
  const input = structuredClone(query);
  if (isIncognitoOpenClawAgentSqlitePath(captured.options.path, captured.options)) {
    return readSessionReactionsInWorker(captured.options, captured.sessionKey, input);
  }
  return await withSessionHistoryWorkerDatabase(
    captured.options,
    (owner) =>
      owner.readReactions({
        sessionKey: captured.sessionKey,
        env: captured.env,
        query: input,
      }),
    projectionLane,
  );
}

export async function listSessionReactions(
  scope: SessionAccessScope,
  input: ListSessionReactionsInput,
) {
  const result = await readReactions(scope, { kind: "list", input });
  if (!Array.isArray(result)) {
    throw new Error("Reaction worker returned a people page for a summary");
  }
  return result;
}

export async function peopleSessionReactions(
  scope: SessionAccessScope,
  input: PeopleSessionReactionsInput,
) {
  const result = await readReactions(scope, { kind: "people", input });
  if (Array.isArray(result)) {
    throw new Error("Reaction worker returned a summary for a people page");
  }
  return result;
}

/** Desired-state writes retain the caller's live guard through transaction and commit admission. */
export async function setSessionReaction(
  scope: SessionAccessScope,
  input: SetSessionReactionInput,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  const captured = captureScope(scope);
  const params = structuredClone(input);
  if (!isIncognitoOpenClawAgentSqlitePath(captured.options.path, captured.options)) {
    await withSessionHistoryWorkerDatabase(
      captured.options,
      async (owner) => {
        const readMetadata = async () => {
          owner.assertCurrent();
          assertCurrent();
          return (await owner.readColdMetadata({ sessionId: params.sessionId, env: captured.env }))
            .archive;
        };
        const archive = await readMetadata();
        assertCurrent();
        if (archive) {
          const target = resolveSqliteTranscriptReadScope({
            ...captured.scope,
            sessionId: params.sessionId,
          });
          await restoreSessionColdTranscript(
            { ...captured.scope, sessionId: params.sessionId },
            assertCurrent,
            { target, readMetadata },
          );
        }
      },
      projectionLane,
    );
  }
  assertCurrent();
  return await runSessionCollaborationWrite(
    captured.scope,
    { type: "reaction", input: { scope: captured.scope, params } },
    (nativeScope) =>
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          assertCurrent();
          const changed = setSessionReactionInDatabase(db, nativeScope.sessionKey, params);
          assertCurrent();
          return changed;
        },
        toDatabaseOptions(resolveSqliteScope(nativeScope)),
      ),
    (changed) => changed,
    assertCurrent,
  );
}
