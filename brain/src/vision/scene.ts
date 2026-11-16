// Frozen observations only: no bridge, tools or live world reads in this layer.
import type { FirstPersonSnapshot } from '../bridge/protocol.ts'
import { blockColors } from '../packdata/index.ts'
import type { PackData } from '../packdata/index.ts'
import { BlockLooks, gridFromBlocks, kindKey, sceneOf, UNLOADED_ID } from '../render/index.ts'
import type { Shape } from '../render/index.ts'
import { isRecord } from '../util.ts'

export const FRAME = { width: 512, height: 288, fov: 70 } as const

export interface SceneDiagnostics {
  missingTextures: { kind: string; face: 'side' | 'top'; replacement: 'magenta' | 'side texture' }[]
  approximations: { kind: string; shape: Shape; reason: string }[]
  unloadedCells: number
}

const looksCache = new WeakMap<object, BlockLooks>()
function looksFor(packdata: PackData): BlockLooks {
  const table = blockColors(packdata)
  let looks = looksCache.get(table)
  if (!looks) { looks = new BlockLooks(table); looksCache.set(table, looks) }
  return looks
}

function coordinate(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 30_000_000) throw new Error(`Invalid snapshot ${label}: expected a finite world coordinate`)
  return value
}

/** Copy only the bounded protocol fields we consume; never stringify an unknown object graph. */
function cameraOf(snapshot: FirstPersonSnapshot): FirstPersonSnapshot['camera'] {
  if (!isRecord(snapshot) || snapshot.version !== 1) throw new Error('Unsupported snapshot version')
  const c = snapshot.camera
  if (!isRecord(c) || !isRecord(c.eye) || !isRecord(c.look)) throw new Error('Invalid snapshot camera')
  const eye = { x: coordinate(c.eye.x, 'eye.x'), y: coordinate(c.eye.y, 'eye.y'), z: coordinate(c.eye.z, 'eye.z') }
  const look = { x: coordinate(c.look.x, 'look.x'), y: coordinate(c.look.y, 'look.y'), z: coordinate(c.look.z, 'look.z') }
  if (Math.hypot(look.x, look.y, look.z) < 1e-12) throw new Error('Invalid snapshot camera: look direction must be nonzero')
  if (!Number.isFinite(c.yaw) || !Number.isFinite(c.pitch)) throw new Error('Invalid snapshot camera angles')
  return { eye, look, yaw: c.yaw, pitch: c.pitch }
}

export function snapshotScene(snapshot: FirstPersonSnapshot, packdata: PackData) {
  const camera = cameraOf(snapshot)
  const blocks = snapshot.blocks
  if (!isRecord(blocks)) throw new Error('Invalid snapshot blocks')
  // gridFromBlocks checks dimensions, run coverage and palette indices. Bound the input
  // arrays/strings before asking it to allocate or iterate; extra nested fields are unused.
  if (!Array.isArray(blocks.palette) || blocks.palette.length > 65535 || blocks.palette.some(k => !isRecord(k) || typeof k.id !== 'string' || k.id.length > 256 || (k.meta !== undefined && (!Number.isInteger(k.meta) || k.meta < 0 || k.meta > 2147483647)))) throw new Error('Invalid snapshot palette')
  if (!Array.isArray(blocks.runs) || blocks.runs.length > 2 * 64 ** 3) throw new Error('Invalid snapshot runs: too many cells')
  for (const axis of ['x', 'y', 'z'] as const) coordinate(blocks[axis], `blocks.${axis}`)
  const grid = gridFromBlocks(blocks)
  let unloadedCells = 0
  for (const cell of grid.cells) if (grid.kinds[cell].id === UNLOADED_ID) unloadedCells++
  if (blocks.unloaded !== undefined && blocks.unloaded !== unloadedCells) throw new Error('Invalid snapshot: unloaded count does not match unknown cells')
  if (!packdata.textures) throw new Error('First-person renderer unavailable: pack texture atlas is missing')
  const looks = looksFor(packdata)
  const scene = sceneOf(grid, looks, { textures: packdata.textures, atlasUrl: '/atlas.png' })
  const substitutes: string[] = []
  const diagnostics: SceneDiagnostics = { missingTextures: [], approximations: [], unloadedCells }
  for (let i = 0; i < scene.kinds.length; i++) {
    const k = scene.kinds[i]
    if (!k || !k.count) continue
    const original = blocks.palette[i]
    const kind = kindKey({ id: original.id, meta: original.meta ?? 0 })
    const look = looks.of(grid.kinds[i])
    // All existing leaf-material paths (including mod-name guesses) have texture holes.
    if (/leaves|leaf/i.test(look.tex ?? '')) k.cutout = true
    // Keep the validated probe's clear glass, cutouts and lighting; orbit viewer is unchanged.
    if (/^minecraft:glass$/.test(k.key)) k.alpha = 0.04
    if (k.tex === undefined) {
      substitutes.push(kind)
      diagnostics.missingTextures.push({ kind, face: 'side', replacement: 'magenta' })
      k.side = [255, 0, 255]
      k.top = [255, 0, 255]
    } else if (look.texTop && !packdata.textures.tiles.has(look.texTop)) {
      diagnostics.missingTextures.push({ kind, face: 'top', replacement: 'side texture' })
    }
    const reasons: string[] = []
    if (k.shape !== 'full') reasons.push(`coarse ${k.shape} box; no block model, orientation or connections`)
    if (look.source === 'guess') reasons.push('material and opacity guessed from block name')
    if (look.source === 'hash') reasons.push(`${k.shape} fallback; no known block appearance`)
    if (/stairs/i.test(original.id)) reasons.push('stairs use a full cube; no stair geometry or orientation')
    if (/^gregtech:/i.test(original.id) && k.shape === 'full') reasons.push('GT full-cube representation; no machine, pipe or tile-entity model')
    if (reasons.length) diagnostics.approximations.push({ kind, shape: k.shape, reason: reasons.join('; ') })
  }
  return { scene, camera, substitutes: [...new Set(substitutes)], diagnostics }
}
