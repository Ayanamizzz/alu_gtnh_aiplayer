// Compatibility entry point for offline probe scripts. Production tools import vision/renderer.ts.
import { FirstPersonRenderer, FRAME } from '../vision/renderer.ts'
import { int, obj } from '../tools/schema.ts'
import type { Tool } from '../tools/types.ts'
export { FirstPersonRenderer, FRAME, snapshotScene } from '../vision/renderer.ts'
export type { SnapshotPicture } from '../vision/renderer.ts'

/** Supply this opt-in tool in runTool([firstPersonTool(renderer)], ctx, ...). No model or owner session needed. */
export function firstPersonTool(renderer: Pick<FirstPersonRenderer, 'render'>): Tool {
  return {
    name: 'look_first_person_probe',
    picture: true,
    rawData: true,
    description: 'Look from your current real eyes and direction. Experimental textured reconstruction, not a Minecraft client screenshot; blocks only, no entities or dynamic machine details.',
    inputSchema: obj({ radius: int('Nearby snapshot radius in blocks (default 12).', { min: 0, max: 31 }) }),
    async run(ctx, input: { radius?: number }) {
      const start = performance.now()
      const snapshot = await ctx.bridge.botSnapshot(ctx.botName, input.radius ?? 12)
      const captureMs = performance.now() - start
      const picture = await renderer.render(snapshot, { signal: ctx.signal })
      const { png, jpeg, ...renderInfo } = picture
      const data = { snapshot, ...FRAME, captureMs, ...renderInfo, totalMs: performance.now() - start, pngBytes: png.length, jpegBytes: jpeg.length }
      return {
        content: `Current first-person block reconstruction, ${FRAME.width}×${FRAME.height}, vertical FOV ${FRAME.fov}°, dimension ${snapshot.dim}, tick ${snapshot.tick}. Eye (${Object.values(snapshot.camera.eye).map(n => n.toFixed(2)).join(', ')}), yaw ${snapshot.camera.yaw.toFixed(1)}°, pitch ${snapshot.camera.pitch.toFixed(1)}°. Unloaded cells: ${snapshot.blocks.unloaded ?? 0}; missing textures shown magenta: ${picture.substitutes.join(', ') || 'none'}. No entities, dynamic tile entities, lighting simulation or scenery beyond the captured box. Non-full blocks (stairs, doors, panes, etc.) use approximate shapes.`,
        images: [{ label: 'current view from the bot’s eyes (block reconstruction)', mediaType: 'image/jpeg', data: jpeg }],
        data,
      }
    },
  }
}
