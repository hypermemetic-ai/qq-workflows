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

const ticketToken = z.object({
  type: z.string(), tag: z.string(), nesting: z.number(), content: z.string(),
  attrs: z.array(z.tuple([z.string(), z.union([z.string(), z.number()])])).nullable(),
});
export const ticketTokens = z.array(ticketToken.extend({ children: z.array(ticketToken).nullable() }));
export type TicketTokens = z.infer<typeof ticketTokens>;

export const ticketSnapshotRpc = defineRpc({
  name: "architect.ticket",
  input: z.object({
    cwd: z.string().min(1),
  }),
  output: z.object({
    path: z.string(),
    text: z.string(),
    tokens: ticketTokens,
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
        phase: z.string().optional(),
        completion: z.string().optional(),
        createdAt: z.number().optional(),
        kind: z.string().nullable().optional(),
      }),
    ),
  }),
});
