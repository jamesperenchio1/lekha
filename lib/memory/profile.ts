import { redis } from "./redis";
import { getProfile } from "@/lib/line/client";

export type Profile = {
  displayName: string;
  joinedAt: number;
};

const key = (userId: string) => `user:${userId}:profile`;

export async function getOrCreateProfile(userId: string): Promise<Profile> {
  const existing = await redis().get<Profile>(key(userId));
  if (existing) return existing;
  const lp = await getProfile(userId);
  const profile: Profile = {
    displayName: lp?.displayName ?? "friend",
    joinedAt: Date.now(),
  };
  await redis().set(key(userId), profile);
  return profile;
}

export async function isFirstContact(userId: string): Promise<boolean> {
  return (await redis().exists(key(userId))) === 0;
}
