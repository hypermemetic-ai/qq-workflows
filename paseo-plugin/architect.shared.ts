import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const startArchitectRpc = defineRpc({
  name: "architect.start",
  input: z.object({
    cwd: z.string().min(1),
    title: z.string().optional(),
  }),
  output: z.object({
    agentId: z.string(),
    workspaceId: z.string().nullable().optional(),
  }),
});

export const ticketSnapshotRpc = defineRpc({
  name: "architect.ticket",
  input: z.object({
    cwd: z.string().min(1),
  }),
  output: z.object({
    path: z.string(),
    text: z.string(),
  }),
});

export const childrenRpc = defineRpc({
  name: "architect.children",
  input: z.object({
    cwd: z.string().min(1),
    parentId: z.string().optional(),
  }),
  output: z.object({
    children: z.array(
      z.object({
        id: z.string(),
        role: z.string(),
        agentId: z.string().optional(),
        status: z.string(),
        error: z.string().optional(),
        kind: z.string().nullable().optional(),
      }),
    ),
  }),
});
