import Anthropic from "@anthropic-ai/sdk";

// Sonnet by default since the credits model landed. The expensive knowledge
// lives in the prompts (card text, attack costs, legality, the grading rubric
// and measured centering), not in the model — and at Opus prices a single big
// deck build cost more than the Free tier's entire signup grant. Set
// ANTHROPIC_MODEL in the environment to move it back up if quality slips.
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

// Scanning reads card names/numbers off a photo — Sonnet handles this as well
// as Opus at roughly half the latency and a fifth of the cost. Deck building
// stays on MODEL where the deeper reasoning pays off.
export const SCAN_MODEL = process.env.SCAN_MODEL || "claude-sonnet-5";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}
