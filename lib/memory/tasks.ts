import { redis } from "./redis";

export type Task = {
  id: string;
  title: string;
  notes?: string;
  createdAt: number;
  dueAt?: number; // ms, optional deadline
  doneAt?: number; // null/undefined when open
};

const listKey = (userId: string) => `user:${userId}:tasks`;

export async function addTask(userId: string, t: Omit<Task, "id" | "createdAt">): Promise<Task> {
  const task: Task = { id: crypto.randomUUID(), createdAt: Date.now(), ...t };
  await redis().rpush(listKey(userId), JSON.stringify(task));
  return task;
}

export async function listTasks(
  userId: string,
  filter: "all" | "open" | "done" = "open",
): Promise<Task[]> {
  const raw = await redis().lrange<string | Task>(listKey(userId), 0, -1);
  const items = raw.map((r) => (typeof r === "string" ? (JSON.parse(r) as Task) : r));
  if (filter === "all") return items;
  if (filter === "done") return items.filter((t) => t.doneAt);
  return items.filter((t) => !t.doneAt);
}

export async function completeTask(userId: string, id: string): Promise<Task | null> {
  return await mutateTask(userId, id, (t) => ({ ...t, doneAt: Date.now() }));
}

export async function reopenTask(userId: string, id: string): Promise<Task | null> {
  return await mutateTask(userId, id, (t) => ({ ...t, doneAt: undefined }));
}

export async function updateTask(
  userId: string,
  id: string,
  patch: Partial<Pick<Task, "title" | "notes" | "dueAt">>,
): Promise<Task | null> {
  return await mutateTask(userId, id, (t) => ({ ...t, ...patch }));
}

export async function deleteTask(userId: string, id: string): Promise<boolean> {
  const all = await listTasks(userId, "all");
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  const k = listKey(userId);
  const tx = redis().multi();
  tx.del(k);
  if (next.length) tx.rpush(k, ...next.map((t) => JSON.stringify(t)));
  await tx.exec();
  return true;
}

async function mutateTask(
  userId: string,
  id: string,
  fn: (t: Task) => Task,
): Promise<Task | null> {
  const all = await listTasks(userId, "all");
  let found: Task | null = null;
  const next = all.map((t) => {
    if (t.id === id) {
      found = fn(t);
      return found;
    }
    return t;
  });
  if (!found) return null;
  const k = listKey(userId);
  const tx = redis().multi();
  tx.del(k);
  tx.rpush(k, ...next.map((t) => JSON.stringify(t)));
  await tx.exec();
  return found;
}
