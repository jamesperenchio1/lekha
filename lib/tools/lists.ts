import { z } from "zod";
import { tool } from "ai";
import { redis } from "@/lib/memory/redis";

/**
 * Named list tools — grocery lists, packing lists, to-watch lists, etc.
 * Each list is a Redis List (ordered, allows duplicates) keyed by name.
 * All list names for a user tracked in a separate Redis Set.
 */

const MAX_NAME = 40;
const MAX_ITEM = 300;
const MAX_ITEMS_PER_LIST = 100;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().slice(0, MAX_NAME);
}

const listKey = (userId: string, name: string) => `lists:${userId}:${normalizeName(name)}`;
const namesKey = (userId: string) => `lists:${userId}:_names`;

async function getListItems(userId: string, name: string): Promise<string[]> {
  return redis().lrange<string>(listKey(userId, name), 0, -1);
}

export function buildListTools(userId: string) {
  return {
    add_to_list: tool({
      description:
        "Add an item to a named list (grocery list, packing list, to-watch list, etc.). Creates the list if it doesn't exist. Example: add_to_list('grocery list', 'milk').",
      inputSchema: z.object({
        list_name: z.string().min(1).max(MAX_NAME).describe("Name of the list, e.g. 'grocery list', 'packing list'"),
        item: z.string().min(1).max(MAX_ITEM).describe("Item to add"),
      }),
      execute: async ({ list_name, item }) => {
        const name = normalizeName(list_name);
        const k = listKey(userId, name);
        const current = await redis().llen(k);
        if (current >= MAX_ITEMS_PER_LIST) {
          return { ok: false as const, error: `List "${name}" is full (${MAX_ITEMS_PER_LIST} items max). Remove some items first.` };
        }
        await redis().rpush(k, item.trim());
        await redis().sadd(namesKey(userId), name);
        const total = current + 1;
        return { ok: true as const, list: name, item: item.trim(), total };
      },
    }),

    remove_from_list: tool({
      description:
        "Remove an item from a named list (removes the first matching entry, case-insensitive). Example: remove_from_list('grocery list', 'milk').",
      inputSchema: z.object({
        list_name: z.string().min(1).max(MAX_NAME),
        item: z.string().min(1).max(MAX_ITEM).describe("Exact item text to remove"),
      }),
      execute: async ({ list_name, item }) => {
        const name = normalizeName(list_name);
        const k = listKey(userId, name);
        const items = await getListItems(userId, name);
        // Find case-insensitive match
        const match = items.find((i) => i.toLowerCase() === item.trim().toLowerCase()) ?? item.trim();
        const removed = await redis().lrem(k, 1, match);
        if (removed === 0) {
          return { ok: false as const, error: `"${item}" not found in "${name}".` };
        }
        return { ok: true as const, list: name, removed: match };
      },
    }),

    list_items: tool({
      description:
        "Show all items in a named list. Example: list_items('grocery list') → ['milk', 'eggs', 'bread'].",
      inputSchema: z.object({
        list_name: z.string().min(1).max(MAX_NAME),
      }),
      execute: async ({ list_name }) => {
        const name = normalizeName(list_name);
        const items = await getListItems(userId, name);
        return { ok: true as const, list: name, items, count: items.length };
      },
    }),

    clear_list: tool({
      description: "Remove ALL items from a named list (keeps the list name). Example: clear_list('grocery list').",
      inputSchema: z.object({
        list_name: z.string().min(1).max(MAX_NAME),
      }),
      execute: async ({ list_name }) => {
        const name = normalizeName(list_name);
        await redis().del(listKey(userId, name));
        return { ok: true as const, list: name, cleared: true };
      },
    }),

    show_all_lists: tool({
      description: "Show all of the user's named lists and how many items each has.",
      inputSchema: z.object({}),
      execute: async () => {
        const names = await redis().smembers(namesKey(userId));
        if (!names.length) return { ok: true as const, lists: [] };
        const counts = await Promise.all(
          names.map(async (name) => ({
            name,
            count: await redis().llen(listKey(userId, name)),
          })),
        );
        return { ok: true as const, lists: counts.sort((a, b) => a.name.localeCompare(b.name)) };
      },
    }),

    rename_list: tool({
      description: "Rename an existing list. Items are preserved. Example: rename_list('shopping', 'weekly groceries').",
      inputSchema: z.object({
        old_name: z.string().min(1).max(MAX_NAME),
        new_name: z.string().min(1).max(MAX_NAME),
      }),
      execute: async ({ old_name, new_name }) => {
        const oldN = normalizeName(old_name);
        const newN = normalizeName(new_name);
        if (oldN === newN) return { ok: false as const, error: "Old and new names are the same." };
        const items = await getListItems(userId, oldN);
        if (!items.length && !(await redis().sismember(namesKey(userId), oldN))) {
          return { ok: false as const, error: `List "${oldN}" not found.` };
        }
        // Copy items to new key
        if (items.length) {
          await redis().rpush(listKey(userId, newN), ...items);
        }
        await redis().del(listKey(userId, oldN));
        await redis().srem(namesKey(userId), oldN);
        await redis().sadd(namesKey(userId), newN);
        return { ok: true as const, oldName: oldN, newName: newN, itemsMoved: items.length };
      },
    }),

    delete_list: tool({
      description: "Permanently delete a named list and all its items.",
      inputSchema: z.object({
        list_name: z.string().min(1).max(MAX_NAME),
      }),
      execute: async ({ list_name }) => {
        const name = normalizeName(list_name);
        await redis().del(listKey(userId, name));
        await redis().srem(namesKey(userId), name);
        return { ok: true as const, list: name, deleted: true };
      },
    }),
  };
}
