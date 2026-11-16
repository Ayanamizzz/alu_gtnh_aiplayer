import { BridgeError } from '../bridge/protocol.ts'
import { fail } from './types.ts'
import type { ToolContext, ToolResult } from './types.ts'

const TOTAL_TIMEOUT_MS = 45_000

/** Stops waiting promptly; a dispatched read-only server query may still finish its current tick. */
async function observe<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** Real current-eye observation. It never moves the player or substitutes a schematic/other camera. */
export async function firstPersonView(ctx: ToolContext, input: { radius?: number; x1?: number; y1?: number; z1?: number; x2?: number; y2?: number; z2?: number; from?: string; layer?: number }): Promise<ToolResult> {
  if ([input.x1, input.y1, input.z1, input.x2, input.y2, input.z2, input.from, input.layer].some(value => value !== undefined)) {
    return fail('view:"eyes" captures your actual current eye and aim. Give only radius (2–24); corners, from and layer select schematic views instead. This observation does not turn or move you.')
  }
  const radius = input.radius ?? 12
  if (!Number.isInteger(radius) || radius < 2 || radius > 24) return fail('view:"eyes" radius must be 2–24 blocks (default 12).')
  if (!ctx.firstPerson) return fail('First-person reconstruction is unavailable on this brain. It requires the local renderer, a Chrome/Chromium executable and the pack texture atlas; no Minecraft client is needed. Other view_area modes still work.')
  const start = performance.now()
  const timeout = AbortSignal.timeout(TOTAL_TIMEOUT_MS)
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout
  try {
    signal.throwIfAborted()
    const snapshot = await observe(ctx.bridge.botSnapshot(ctx.botName, radius), signal)
    const captureMs = performance.now() - start
    const picture = await ctx.firstPerson.render(snapshot, { signal, timeoutMs: Math.max(1, Math.floor(TOTAL_TIMEOUT_MS - captureMs)) })
    const { png, jpeg, ...renderInfo } = picture
    const diagnostics = picture.diagnostics
    const missingPreview = picture.substitutes.slice(0, 12).join(', ') || 'none'
    const text = [
      `First-person block reconstruction: 512×288, vertical FOV 70°. Captured ${new Date(snapshot.capturedAt).toISOString()}, dimension ${snapshot.dim}, tick ${snapshot.tick}.`,
      `Eye (${snapshot.camera.eye.x.toFixed(2)}, ${snapshot.camera.eye.y.toFixed(2)}, ${snapshot.camera.eye.z.toFixed(2)}), yaw ${snapshot.camera.yaw.toFixed(1)}°, pitch ${snapshot.camera.pitch.toFixed(1)}°. This is the frozen observation at capture time, not a continuously live picture.`,
      'Use this picture to inspect building space and unexpected obstructions, alongside the design and exact block queries. It is not a Minecraft-client screenshot. No entities, dynamic tile-entity details, animation or actual lighting are rendered. Beyond the captured box is a neutral background, not verified empty space.',
      `Unloaded cells: ${diagnostics.unloadedCells}. Unknown/missing textures are shown as magenta substitutes: ${missingPreview}${picture.substitutes.length > 12 ? `; ${picture.substitutes.length - 12} more in data.diagnostics.missingTextures` : ''}.`,
      'Shapes may be simplified: pipes/machines can appear as solid cubes; doors/stairs/panes may not match their actual shape or open state. Do not infer precise clearance, machine identity or pipe connections from these substitutes.',
      ...(diagnostics.approximations.length ? [`Approximate appearances in the captured box (not all necessarily visible): ${JSON.stringify(diagnostics.approximations.slice(0, 8))}.${diagnostics.approximations.length > 8 ? ` ${diagnostics.approximations.length - 8} more; the complete list is in data.diagnostics.approximations.` : ''}`] : []),
    ]
    return {
      content: text.join('\n'), keepWhole: true,
      images: [{ label: `first-person reconstruction at tick ${snapshot.tick}`, mediaType: 'image/jpeg', data: jpeg }],
      data: { snapshot, width: 512, height: 288, fov: 70, captureMs, ...renderInfo,
        totalMs: performance.now() - start, pngBytes: png.length, jpegBytes: jpeg.length },
    }
  } catch (error) {
    if (ctx.signal?.aborted) return fail('First-person observation canceled. No completed picture was returned.')
    if (timeout.aborted) return fail('First-person observation timed out after 45 seconds. No completed picture was returned; try again when the local renderer is available.')
    if (error instanceof BridgeError && /unknown|no such|not found/i.test(error.message)) {
      return fail(`First-person snapshot was unavailable from the body (${error.code}: ${error.message}). Check that the bot is online and the body includes bot.snapshot; no schematic was substituted.`)
    }
    return fail(`First-person observation failed: ${error instanceof Error ? error.message : String(error)}. No completed picture was returned.`)
  }
}
