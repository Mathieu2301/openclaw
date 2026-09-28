import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { property, state as litState } from "lit/decorators.js";
import type {
  ChatReactionPerson,
  ChatReactionSummary,
} from "../../../../../packages/gateway-protocol/src/chat-reactions.js";
import { configureAnchoredPopup } from "../../../components/anchored-overlay.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/modal-dialog.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { emojiForShortcode, suggestEmoji } from "../../../lib/chat/emoji.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { ChatReactionsController } from "../chat-reactions.ts";
import "../../../styles/chat/reactions.css";

const QUICK_EMOJI = ["thumbsup", "heart", "joy", "tada", "eyes", "rocket", "fire", "clap"];
const ADD_REACTION_ICON = strokeIcon(svg`<path d="M22 11v1a10 10 0 1 1-9-10" />
  <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6" />`);

/** Mounted bubbles subscribe to their pane cache; no transcript or browser-storage writes. */
export class ChatMessageReactions extends OpenClawLightDomElement {
  @property({ attribute: false }) controller?: ChatReactionsController;
  @property({ attribute: false }) actions: TemplateResult | typeof nothing = nothing;
  @property() messageId = "";
  @litState() private pickerOpen = false;
  @litState() private query = "";
  @litState() private peopleEmoji: string | null = null;
  @litState() private people: ChatReactionPerson[] = [];
  @litState() private peopleLoading = false;
  @litState() private peopleError = false;
  @litState() private nextCursor?: string;
  private unsubscribe?: () => void;
  private scopeVersion = -1;
  private pickerNeedsFocus = false;
  private peopleGeneration = 0;

  override connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.closeDialogs();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (!this.isConnected) {
      return;
    }
    if (changed.has("controller") || changed.has("messageId") || !this.unsubscribe) {
      this.unsubscribe?.();
      this.closeDialogs();
      this.scopeVersion = this.controller?.scopeVersion ?? -1;
      this.unsubscribe = this.controller?.subscribe(this.messageId, () => {
        if (this.scopeVersion !== this.controller?.scopeVersion) {
          this.scopeVersion = this.controller?.scopeVersion ?? -1;
          this.closeDialogs();
        }
        this.requestUpdate();
      });
    }
  }

  private closeDialogs() {
    this.closePicker();
    this.peopleEmoji = null;
    this.peopleGeneration += 1;
    this.people = [];
    this.peopleLoading = false;
    this.peopleError = false;
    this.nextCursor = undefined;
  }

  private selectEmoji(emoji: string) {
    const state = this.controller?.read(this.messageId);
    if (!state || state.pending || state.loading || !this.controller?.canReact) {
      return;
    }
    this.closePicker(this.pickerOpen);
    const active = !state.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.reactedByMe,
    );
    void this.controller.set(this.messageId, emoji, active);
  }

  private async loadPeople(emoji: string, append = false) {
    const controller = this.controller;
    if (!controller) {
      return;
    }
    const generation = ++this.peopleGeneration;
    const scopeVersion = controller.scopeVersion;
    const messageId = this.messageId;
    this.peopleEmoji = emoji;
    this.peopleLoading = true;
    this.peopleError = false;
    if (!append) {
      this.people = [];
      this.nextCursor = undefined;
    }
    const current = () =>
      this.isConnected &&
      this.controller === controller &&
      controller.available &&
      controller.scopeVersion === scopeVersion &&
      this.messageId === messageId &&
      this.peopleGeneration === generation;
    try {
      const result = await controller.people(
        messageId,
        emoji,
        append ? this.nextCursor : undefined,
      );
      if (!current() || !result) {
        return;
      }
      const merged = new Map(
        (append ? this.people : []).map((person) => [
          `${person.identity.type}:${person.identity.id}`,
          person,
        ]),
      );
      result.reactors.forEach((person) =>
        merged.set(`${person.identity.type}:${person.identity.id}`, person),
      );
      this.people = [...merged.values()];
      this.nextCursor = result.nextCursor;
    } catch {
      if (current()) {
        this.peopleError = true;
      }
    } finally {
      if (current()) {
        this.peopleLoading = false;
      }
    }
  }

  private personLabel(person: ChatReactionPerson) {
    return person.identity.type === "agent"
      ? t("chat.reactions.agentName", { name: person.label })
      : person.label;
  }

  private names(reaction: ChatReactionSummary) {
    const names = reaction.reactors.map((person) => this.personLabel(person)).join(", ");
    const count = Math.max(0, reaction.count - reaction.reactors.length);
    return t(count ? "chat.reactions.moreNames" : "chat.reactions.names", {
      names,
      count: String(count),
      emoji: reaction.emoji,
    });
  }

  private closePicker(restoreFocus = false) {
    this.pickerOpen = false;
    this.pickerNeedsFocus = false;
    this.ownerDocument.removeEventListener("pointerdown", this.dismissPickerOutside, true);
    this.ownerDocument.removeEventListener("focusin", this.dismissPickerOutside, true);
    if (restoreFocus) {
      this.querySelector<HTMLButtonElement>(".chat-reaction-add")?.focus({ preventScroll: true });
    }
  }

  private readonly dismissPickerOutside = (event: Event) => {
    const path = event.composedPath();
    const popup = this.querySelector("wa-popup");
    const trigger = this.querySelector(".chat-reaction-add");
    if ((!popup || !path.includes(popup)) && (!trigger || !path.includes(trigger))) {
      this.closePicker();
    }
  };

  private togglePicker() {
    if (this.pickerOpen) {
      this.closePicker();
      return;
    }
    this.query = "";
    this.pickerOpen = true;
    this.pickerNeedsFocus = true;
    this.ownerDocument.addEventListener("pointerdown", this.dismissPickerOutside, true);
    this.ownerDocument.addEventListener("focusin", this.dismissPickerOutside, true);
  }

  protected override updated() {
    const popup = this.querySelector<WaPopup>("wa-popup");
    const trigger = this.querySelector<HTMLButtonElement>(".chat-reaction-add");
    if (popup && trigger && this.pickerOpen) {
      configureAnchoredPopup(popup, trigger, "top");
    }
  }

  private readonly focusPicker = () => {
    if (this.pickerOpen && this.pickerNeedsFocus) {
      this.pickerNeedsFocus = false;
      // Emoji choices come first; do not summon the mobile keyboard until Search is tapped.
      this.querySelector<HTMLButtonElement>(".chat-reaction-picker button")?.focus({
        preventScroll: true,
      });
    }
  };

  private renderPicker() {
    const names = this.query.trim()
      ? suggestEmoji(this.query.trim().toLowerCase().replace(/^:/u, ""))
      : QUICK_EMOJI;
    return html`<wa-popup active @wa-reposition=${this.focusPicker}>
      <section
        class="chat-reaction-popover"
        role="dialog"
        aria-label=${t("chat.reactions.add")}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            this.closePicker(true);
          }
        }}
      >
        <div class="chat-reaction-picker" role="group" aria-label=${t("chat.reactions.add")}>
          ${names.map((name) => {
            const emoji = emojiForShortcode(name);
            return emoji
              ? html`<button
                  type="button"
                  aria-label=${name}
                  @click=${() => this.selectEmoji(emoji)}
                >
                  ${emoji}
                </button>`
              : nothing;
          })}
        </div>
        ${names.length ? nothing : html`<p role="status">${t("chat.reactions.empty")}</p>`}
        <input
          class="chat-reaction-search"
          type="search"
          aria-label=${t("chat.reactions.search")}
          placeholder=${t("chat.reactions.search")}
          autocomplete="off"
          .value=${this.query}
          @input=${(event: InputEvent) => {
            this.query = (event.target as HTMLInputElement).value;
          }}
        />
      </section>
    </wa-popup>`;
  }

  private renderPeople(reactions: ChatReactionSummary[]) {
    const emoji = this.peopleEmoji;
    if (!emoji) {
      return nothing;
    }
    return html`<openclaw-modal-dialog
      label=${t("chat.reactions.people")}
      @modal-cancel=${() => this.closeDialogs()}
    >
      <section class="chat-reaction-dialog">
        <header>
          <h2>${t("chat.reactions.people")}</h2>
          <button
            type="button"
            class="btn btn--icon"
            aria-label=${t("common.close")}
            @click=${() => this.closeDialogs()}
          >
            ${icons.x}
          </button>
        </header>
        <div class="chat-reaction-tabs" role="group" aria-label=${t("chat.reactions.people")}>
          ${reactions.map((reaction) => html`<button type="button" class="chat-reaction-chip" aria-pressed=${String(emoji === reaction.emoji)} @click=${() => void this.loadPeople(reaction.emoji)}>${reaction.emoji} ${reaction.count}</button>`)}
        </div>
        <ul class="chat-reaction-people">
          ${this.people.map((person) => html`<li><span class="chat-reaction-person-avatar" aria-hidden="true">${person.label.slice(0, 1)}</span><span>${this.personLabel(person)}</span></li>`)}
        </ul>
        ${this.peopleLoading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
        ${this.peopleError ? html`<p role="alert">${t("chat.reactions.peopleFailed")} <button type="button" class="btn" @click=${() => void this.loadPeople(emoji, this.people.length > 0)}>${t("chat.reactions.retry")}</button></p>` : nothing}
        ${!this.peopleLoading && !this.peopleError && !this.people.length ? html`<p>${t("chat.reactions.none")}</p>` : nothing}
        ${this.nextCursor && !this.peopleError ? html`<button type="button" class="btn" ?disabled=${this.peopleLoading} @click=${() => void this.loadPeople(emoji, true)}>${t("chat.reactions.more")}</button>` : nothing}
      </section>
    </openclaw-modal-dialog>`;
  }

  override render() {
    const state = this.controller?.read(this.messageId);
    if (!state) {
      return this.actions;
    }
    const disabled = state.pending || state.loading || !this.controller?.canReact;
    return html`<div class="chat-reactions" aria-busy=${String(state.pending || state.loading)}>
        ${state.reactions.map(
          (reaction) => html`<openclaw-tooltip content=${this.names(reaction)}>
            <span class="chat-reaction-group" data-reacted=${String(reaction.reactedByMe)}>
              <button
                type="button"
                class="chat-reaction-toggle"
                data-emoji=${reaction.emoji}
                aria-label=${t("chat.reactions.toggle", { emoji: reaction.emoji, count: String(reaction.count) })}
                aria-pressed=${String(reaction.reactedByMe)}
                ?disabled=${disabled}
                @click=${() => this.selectEmoji(reaction.emoji)}
              >
                <span>${reaction.emoji}</span>
              </button>
              <button
                type="button"
                class="chat-reaction-count"
                aria-label=${t("chat.reactions.peopleForEmoji", { emoji: reaction.emoji })}
                aria-haspopup="dialog"
                @click=${() => void this.loadPeople(reaction.emoji)}
              >
                ${reaction.count}
              </button>
            </span>
          </openclaw-tooltip>`,
        )}
        ${
          this.controller?.canReact
            ? html`<openclaw-tooltip content=${t("chat.reactions.add")} .disabled=${this.pickerOpen}
                ><button
                  type="button"
                  class="chat-reaction-add"
                  aria-label=${t("chat.reactions.add")}
                  aria-haspopup="dialog"
                  aria-expanded=${String(this.pickerOpen)}
                  ?disabled=${disabled}
                  @click=${() => this.togglePicker()}
                >
                  <span class="chat-reaction-add-icon" aria-hidden="true"
                    >${ADD_REACTION_ICON}</span
                  >
                </button></openclaw-tooltip
              >`
            : nothing
        }
        ${this.actions}
      </div>
      ${state.error ? html`<span class="chat-reaction-error" role="alert">${t(state.error === "save" ? "chat.reactions.saveFailed" : "chat.reactions.loadFailed")} <button type="button" ?disabled=${state.pending || state.loading} @click=${() => this.controller?.retry(this.messageId)}>${t("chat.reactions.retry")}</button></span>` : nothing}
      ${this.pickerOpen ? this.renderPicker() : nothing} ${this.renderPeople(state.reactions)}`;
  }
}

customElements.define("openclaw-chat-message-reactions", ChatMessageReactions);
