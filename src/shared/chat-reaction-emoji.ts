// The supported Node runtime has Unicode string properties; the shared TS target predates v literals.
const reactionEmoji = new RegExp("^\\p{RGI_Emoji}$", "v");

export function assertChatReactionEmoji(emoji: string): void {
  // One Unicode emoji sequence, including modifiers, flags, keycaps and ZWJ families.
  if (!reactionEmoji.test(emoji)) {
    throw new Error("Choose one emoji for the reaction");
  }
}
