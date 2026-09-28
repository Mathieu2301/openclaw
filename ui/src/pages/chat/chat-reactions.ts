import type {
  ChatReactionSummary,
  ChatReactionsChangedEvent,
  ChatReactionsListResult,
  ChatReactionsPeopleResult,
} from "../../../../packages/gateway-protocol/src/chat-reactions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

export type ChatReactionState = {
  reactions: ChatReactionSummary[];
  loading: boolean;
  pending: boolean;
  error?: "load" | "save";
};
export type ChatReactionScope = {
  client: Pick<GatewayBrowserClient, "request">;
  connectionEpoch: number;
  sessionKey: string;
  agentId: string;
  sessionId: string;
  canReact: boolean;
  isCurrent: () => boolean;
};
type Entry = ChatReactionState & {
  listeners: Set<() => void>;
  revision: number;
  dirty: boolean;
  retryWrite?: { emoji: string; active: boolean };
};

/** One pane owns the visible-window cache; mounted rows never issue individual list reads. */
export class ChatReactionsController {
  private scope: ChatReactionScope | null = null;
  private readonly entries = new Map<string, Entry>();
  private scheduled = false;
  private reading = false;
  private generation = 0;

  get scopeVersion() {
    return this.generation;
  }
  get canReact() {
    return Boolean(this.scope?.canReact && this.scope.isCurrent());
  }
  get available() {
    return Boolean(this.scope?.isCurrent());
  }

  configure(next: ChatReactionScope | null): void {
    const previous = this.scope;
    if (
      previous &&
      next &&
      previous.client === next.client &&
      previous.connectionEpoch === next.connectionEpoch &&
      previous.sessionKey === next.sessionKey &&
      previous.agentId === next.agentId &&
      previous.sessionId === next.sessionId &&
      previous.canReact === next.canReact
    ) {
      this.scope = next;
      return;
    }
    if (!previous && !next) {
      return;
    }
    this.scope = next;
    this.generation += 1;
    this.reading = false;
    for (const entry of this.entries.values()) {
      Object.assign(entry, {
        reactions: [],
        loading: Boolean(next),
        pending: false,
        error: undefined,
        retryWrite: undefined,
        dirty: Boolean(next),
        revision: entry.revision + 1,
      });
      this.notify(entry);
    }
    this.schedule();
  }

  read(messageId: string): ChatReactionState | undefined {
    return this.available ? this.entries.get(messageId) : undefined;
  }

  subscribe(messageId: string, listener: () => void): () => void {
    let entry = this.entries.get(messageId);
    if (!entry) {
      entry = {
        reactions: [],
        loading: this.available,
        pending: false,
        listeners: new Set(),
        revision: 0,
        dirty: true,
      };
      this.entries.set(messageId, entry);
    }
    entry.listeners.add(listener);
    this.schedule();
    const subscribed = entry;
    return () => {
      subscribed.listeners.delete(listener);
      if (!subscribed.listeners.size && this.entries.get(messageId) === subscribed) {
        this.entries.delete(messageId);
      }
    };
  }

  private current(scope: ChatReactionScope, generation: number): boolean {
    return (
      this.generation === generation && this.scope?.client === scope.client && scope.isCurrent()
    );
  }
  private notify(entry: Entry) {
    entry.listeners.forEach((listener) => listener());
  }
  private params(scope: ChatReactionScope) {
    return { sessionKey: scope.sessionKey, agentId: scope.agentId, sessionId: scope.sessionId };
  }
  private schedule() {
    if (this.scheduled || this.reading || !this.available) {
      return;
    }
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.flush();
    });
  }
  private async flush(): Promise<void> {
    const scope = this.scope;
    if (!scope || !scope.isCurrent() || this.reading) {
      return;
    }
    const batch = [...this.entries]
      .filter(([, entry]) => entry.dirty && !entry.pending)
      .slice(0, 100);
    if (!batch.length) {
      return;
    }
    const generation = this.generation;
    this.reading = true;
    const reads = batch.map(([id, entry]) => {
      entry.dirty = false;
      entry.loading = true;
      this.notify(entry);
      return { id, entry, revision: entry.revision };
    });
    try {
      const result = await scope.client.request<ChatReactionsListResult>("chat.reactions.list", {
        ...this.params(scope),
        messageIds: reads.map(({ id }) => id),
      });
      if (!this.current(scope, generation)) {
        return;
      }
      if (result.sessionId !== scope.sessionId) {
        throw new Error("Reaction session changed");
      }
      for (const { id, entry, revision } of reads) {
        if (this.entries.get(id) !== entry || entry.revision !== revision) {
          continue;
        }
        entry.reactions =
          result.messages.find((message) => message.messageId === id)?.reactions ?? [];
        entry.loading = false;
        if (entry.error === "load") {
          entry.error = undefined;
        }
        this.notify(entry);
      }
    } catch {
      if (this.current(scope, generation)) {
        for (const { id, entry, revision } of reads) {
          if (this.entries.get(id) !== entry || entry.revision !== revision) {
            continue;
          }
          entry.loading = false;
          entry.error = "load";
          this.notify(entry);
        }
      }
    } finally {
      if (this.current(scope, generation)) {
        this.reading = false;
        this.schedule();
      }
    }
  }

  changed(event: ChatReactionsChangedEvent): void {
    const scope = this.scope;
    if (
      !scope ||
      !scope.isCurrent() ||
      event.agentId !== scope.agentId ||
      event.sessionId !== scope.sessionId ||
      !areUiSessionKeysEquivalent(event.sessionKey, scope.sessionKey)
    ) {
      return;
    }
    for (const id of event.messageIds) {
      this.invalidate(id);
    }
    this.schedule();
  }
  private invalidate(id: string) {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    entry.revision += 1;
    entry.dirty = true;
    entry.loading = true;
    this.notify(entry);
  }

  async set(messageId: string, emoji: string, active: boolean): Promise<void> {
    const scope = this.scope;
    const entry = this.entries.get(messageId);
    if (!scope || !this.canReact || !entry || entry.pending) {
      return;
    }
    const generation = this.generation;
    entry.pending = true;
    entry.error = undefined;
    entry.retryWrite = undefined;
    entry.revision += 1;
    this.notify(entry);
    try {
      await scope.client.request("chat.reactions.set", {
        ...this.params(scope),
        messageId,
        emoji,
        active,
      });
      if (!this.current(scope, generation) || this.entries.get(messageId) !== entry) {
        return;
      }
      this.invalidate(messageId);
    } catch {
      if (!this.current(scope, generation) || this.entries.get(messageId) !== entry) {
        return;
      }
      entry.error = "save";
      entry.retryWrite = { emoji, active };
      // A disconnected response may hide a committed write. Reconcile before another toggle.
      this.invalidate(messageId);
    } finally {
      if (this.current(scope, generation) && this.entries.get(messageId) === entry) {
        entry.pending = false;
        this.notify(entry);
        this.schedule();
      }
    }
  }
  retry(messageId: string): void {
    const entry = this.entries.get(messageId);
    if (!entry) {
      return;
    }
    if (entry.retryWrite) {
      void this.set(messageId, entry.retryWrite.emoji, entry.retryWrite.active);
    } else {
      this.invalidate(messageId);
      this.schedule();
    }
  }

  async people(
    messageId: string,
    emoji: string,
    cursor?: string,
  ): Promise<ChatReactionsPeopleResult | null> {
    const scope = this.scope;
    if (!scope || !scope.isCurrent()) {
      return null;
    }
    const generation = this.generation;
    const result = await scope.client.request<ChatReactionsPeopleResult>("chat.reactions.people", {
      ...this.params(scope),
      messageId,
      emoji,
      ...(cursor ? { cursor } : {}),
    });
    if (!this.current(scope, generation)) {
      return null;
    }
    if (
      result.sessionId !== scope.sessionId ||
      result.messageId !== messageId ||
      result.emoji !== emoji
    ) {
      throw new Error("Reaction details changed");
    }
    return result;
  }
}
