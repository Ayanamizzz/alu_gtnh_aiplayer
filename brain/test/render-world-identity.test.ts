import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blocksOfGrid, gridFromBlocks, BlockLooks, sceneOf } from '../src/render/index.ts'

test('a world snapshot keeps distinct extended GregTech ore metadata through rendering and replay', () => {
  // Values observed in the actual test-base capture, not derived from the renderer.
  const blocks = { x: -580, y: 68, z: 96, sx: 2, sy: 1, sz: 1,
    palette: [{ id: 'minecraft:air' }, { id: 'gregtech:gt.blockores2', meta: 24032 }, { id: 'gregtech:gt.blockores2', meta: 24930 }], runs: [1, 1, 2, 1] }
  const grid = gridFromBlocks(blocks)
  assert.deepEqual(grid.kinds.slice(1).map(kind => kind.meta), [24032, 24930])
  const scene = sceneOf(grid, new BlockLooks([]))
  assert.deepEqual(scene.kinds.slice(1).map(kind => kind?.key), ['gregtech:gt.blockores2/24032', 'gregtech:gt.blockores2/24930'])
  assert.deepEqual(gridFromBlocks(blocksOfGrid(grid)).kinds, grid.kinds)
})
