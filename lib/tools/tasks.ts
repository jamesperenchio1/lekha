import { z } from "zod";
import { tool } from "ai";
import {
  addTask,
  listTasks,
  completeTask,
  reopenTask,
  updateTask,
  deleteTask,
} from "@/lib/memory/tasks";

export function buildTaskTools(userId: string) {
  return {
    add_task: tool({
      description:
        "Add a task (a persistent open work item). Use for things the user wants to track until done — distinct from reminders, which fire and disappear. Optional dueAt for soft deadlines.",
      inputSchema: z.object({
        title: z.string().min(2).max(200),
        notes: z.string().max(2000).optional(),
        dueAt: z.string().optional().describe("ISO 8601 deadline. Optional."),
      }),
      execute: async ({ title, notes, dueAt }) => {
        const t = await addTask(userId, {
          title,
          notes,
          dueAt: dueAt ? new Date(dueAt).getTime() : undefined,
        });
        return { ok: true, task: t };
      },
    }),

    list_tasks: tool({
      description: "List tasks. Filter 'open' (default), 'done', or 'all'.",
      inputSchema: z.object({
        filter: z.enum(["all", "open", "done"]).default("open"),
      }),
      execute: async ({ filter }) => ({ tasks: await listTasks(userId, filter) }),
    }),

    complete_task: tool({
      description: "Mark a task done by id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const t = await completeTask(userId, id);
        return t ? { ok: true, task: t } : { ok: false, error: "Task not found" };
      },
    }),

    reopen_task: tool({
      description: "Re-open a previously-completed task.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const t = await reopenTask(userId, id);
        return t ? { ok: true, task: t } : { ok: false, error: "Task not found" };
      },
    }),

    update_task: tool({
      description: "Edit a task's title, notes, or due date by id.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().min(2).max(200).optional(),
        notes: z.string().max(2000).optional(),
        dueAt: z.string().optional(),
      }),
      execute: async ({ id, title, notes, dueAt }) => {
        const patch: Parameters<typeof updateTask>[2] = {};
        if (title !== undefined) patch.title = title;
        if (notes !== undefined) patch.notes = notes;
        if (dueAt !== undefined) patch.dueAt = new Date(dueAt).getTime();
        const t = await updateTask(userId, id, patch);
        return t ? { ok: true, task: t } : { ok: false, error: "Task not found" };
      },
    }),

    delete_task: tool({
      description: "Delete a task by id permanently.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ ok: await deleteTask(userId, id) }),
    }),
  };
}
