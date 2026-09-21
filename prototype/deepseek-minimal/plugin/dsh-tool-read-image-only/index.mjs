/**
 * Prototype-local Cordis plugin that mounts ONLY `read_image`.
 *
 * Rationale: upstream `@deepseek-ai/dsh-tool-fs` exports a single plugin
 * (`apply`) that unconditionally registers read + write + edit alongside
 * read_image (packages/fs/tool-fs/src/index.ts). The exported named
 * `applyReadImageTool` is therefore the only way to expose read_image without
 * the bundled editors. It is reachable through the `./src/*` export of the
 * package, which exists only in a source checkout (the packaged lib/ bundle
 * drops it). This file is the "small local registration wrapper" the ticket
 * authorizes; it reuses the upstream implementation verbatim and re-implements
 * nothing.
 *
 * The plugin declares the same service injections read_image itself needs:
 * the tools registry, a filesystem backend, and (gated below) a durable
 * attachment store. `llm` is read at execution time by the upstream route
 * gate; `systemPrompt` is required by the tool suite's own `inject` contract.
 *
 * @module dsh-tool-read-image-only
 */

import { applyReadImageTool } from '@deepseek-ai/dsh-tool-fs/src/read-image.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-read-image-only'

/** Services required before this plugin registers anything. */
export const inject = ['tools', 'fs']

/**
 * Register exactly one model-facing tool: `read_image`.
 * @param ctx - the plugin scope; the tool only exists while `attachments` is mounted.
 */
export function apply(ctx) {
  ctx.inject(['attachments'], (imageCtx) => {
    applyReadImageTool(imageCtx)
  })
}
