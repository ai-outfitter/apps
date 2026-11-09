/**
 * A rough token count for display: about four characters per token for English text
 * and JSON. Not the model's tokenizer; shown with "≈".
 */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 4);
}

/** "≈1,234 tokens". */
export const tokenLabel = (text: string) => `≈${estimateTokens(text).toLocaleString("en-US")} tokens`;
