import { redis } from "./redis";

const MAX_BYTES = 4096;

export type UserFacts = {
  /** Free-form bullets (~30 max), each a short fact about the user. */
  bullets: string[];
  /** Last time facts were extracted/refreshed (ms). */
  updatedAt: number;
};

const key = (userId: string) => `user:${userId}:facts`;

export async function loadFacts(userId: string): Promise<UserFacts> {
  const v = await redis().get<UserFacts>(key(userId));
  return v ?? { bullets: [], updatedAt: 0 };
}

export async function saveFacts(userId: string, facts: UserFacts): Promise<void> {
  // Cap the bullets list and trim oversize entries.
  const bullets = facts.bullets.slice(0, 40).map((b) => b.slice(0, 200));
  let blob = JSON.stringify({ bullets, updatedAt: facts.updatedAt });
  while (Buffer.byteLength(blob, "utf8") > MAX_BYTES && bullets.length > 0) {
    bullets.pop();
    blob = JSON.stringify({ bullets, updatedAt: facts.updatedAt });
  }
  await redis().set(key(userId), { bullets, updatedAt: facts.updatedAt });
}

/** Add a single user-asserted fact ("remember this") with simple dedupe. */
export async function appendFact(userId: string, fact: string): Promise<void> {
  const facts = await loadFacts(userId);
  const norm = fact.trim().slice(0, 200);
  if (!norm) return;
  if (facts.bullets.some((b) => b.toLowerCase() === norm.toLowerCase())) return;
  facts.bullets.push(norm);
  facts.updatedAt = Date.now();
  await saveFacts(userId, facts);
}

export function factsToPromptBlock(facts: UserFacts): string {
  if (!facts.bullets.length) return "";
  const lines = facts.bullets.map((b) => `- ${b}`).join("\n");
  return `\n\nWhat you remember about this user:\n${lines}`;
}
