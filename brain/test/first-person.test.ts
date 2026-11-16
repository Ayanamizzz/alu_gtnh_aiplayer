import assert from 'node:assert/strict'
import { test } from 'node:test'
import { snapshotScene } from '../src/experimental/first-person.ts'
import type { FirstPersonSnapshot } from '../src/bridge/protocol.ts'
import type { Scene } from '../src/render/scene.ts'

const viewer = await import(new URL('../src/panel/public/viewer3d.js', import.meta.url).href) as {
  firstPersonMatrix(eye: number[], look: number[], aspect: number, fov?: number): Float32Array
  expandRuns(scene: Scene): Uint16Array
  buildMesh(scene: Scene, cells: Uint16Array): { faces: number }
}

function screen(m: Float32Array, point: number[]) {
  const v = [...point, 1]
  const clip = [0, 1, 2, 3].map(row => v.reduce((sum, value, col) => sum + m[col * 4 + row] * value, 0))
  return clip.slice(0, 3).map(value => value / clip[3])
}

test('look south from actual eyes: forward is centred, west is right, and up is up', () => {
  const matrix = viewer.firstPersonMatrix([8, 9, 10], [0, 0, 1], 16 / 9)
  const center = screen(matrix, [8, 9, 15])
  assert.ok(Math.abs(center[0]) < 1e-6 && Math.abs(center[1]) < 1e-6)
  assert.ok(center[2] > -1 && center[2] < 1)
  assert.ok(screen(matrix, [7, 9, 15])[0] > 0)
  assert.ok(screen(matrix, [8, 10, 15])[1] > 0)
  // A 70° vertical FOV puts a point 35° above the centre on the top image edge.
  assert.ok(Math.abs(screen(matrix, [8, 9 + 5 * Math.tan(35 * Math.PI / 180), 15])[1] - 1) < 1e-5)
})

test('turn north and downward: the real look, not an orbit centre, defines the image centre', () => {
  const matrix = viewer.firstPersonMatrix([8, 9, 10], [0, -0.6, -0.8], 16 / 9)
  const point = screen(matrix, [8, 6, 6])
  assert.ok(Math.abs(point[0]) < 1e-6 && Math.abs(point[1]) < 1e-6)
  assert.ok(screen(matrix, [9, 6, 6])[0] > 0)
})

const snapshot: FirstPersonSnapshot = {
  version: 1, bot: 'Probe', dim: 0, tick: 500, time: 6000, capturedAt: 1,
  camera: { eye: { x: 0.5, y: 1.62, z: 0.5 }, look: { x: 0, y: 0, z: 1 }, yaw: 0, pitch: 0 },
  blocks: { x: 0, y: 0, z: 0, sx: 3, sy: 1, sz: 1, palette: [
    { id: 'minecraft:air', meta: 0 }, { id: 'minecraft:leaves', meta: 4 }, { id: 'minecraft:stone', meta: 0 },
  ], runs: [1, 2, 2, 1], unloaded: 0 },
}
const packdata = { dir: '/unused', textures: { file: '/unused', tile: 16, columns: 2, rows: 1, tiles: new Map([['leaves_oak', 0], ['stone', 1]]), version: 'test' } }

test('see through leaf holes: the adjacent leaves and wall still have visible faces', () => {
  const { scene } = snapshotScene(snapshot, packdata)
  // Leaf-leaf boundary keeps both faces; leaf-stone keeps the stone face, hides only its touching leaf face.
  // Three cubes have 18 faces minus that one hidden leaf face = 17 (old solid-leaves path leaves only 14).
  assert.equal(viewer.buildMesh(scene, viewer.expandRuns(scene)).faces, 17)
  assert.deepEqual(snapshot.blocks.runs, [1, 2, 2, 1])
  assert.equal(snapshot.blocks.palette[1].id, 'minecraft:leaves')
})

test('unloaded cells are visible unknowns, and preparing a picture does not rewrite the stored observation', () => {
  const unknown = structuredClone(snapshot)
  unknown.blocks = { x: 0, y: 0, z: 0, sx: 1, sy: 1, sz: 1, palette: [{ id: 'minecraft:air' }, { id: '?' }], runs: [1, 1], unloaded: 1 }
  const before = JSON.stringify(unknown)
  const { scene, substitutes } = snapshotScene(unknown, packdata)
  assert.deepEqual(substitutes, ['?'])
  assert.deepEqual(scene.kinds[1]?.side, [255, 0, 255])
  assert.equal(viewer.buildMesh(scene, viewer.expandRuns(scene)).faces, 6)
  assert.equal(JSON.stringify(unknown), before)
})
