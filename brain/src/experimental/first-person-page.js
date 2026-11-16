// Deliberately no UI, orbit camera, clipping controls, axes or live world reads.
import { buildMesh, expandRuns, FLOATS_PER_VERTEX as F, firstPersonMatrix, VERTEX_SHADER, FRAGMENT_SHADER } from '/viewer3d.js'

const canvas = document.querySelector('canvas')
const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true })
if (!gl) throw new Error('WebGL unavailable')
const compile = (type, source) => {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader))
  return shader
}
const program = gl.createProgram()
gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER))
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER))
gl.linkProgram(program)
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program))
gl.useProgram(program)
const attributes = [['p', 3, 0], ['uv', 2, 3], ['c', 4, 5], ['l', 1, 9]].map(([name, size, offset]) => ({ at: gl.getAttribLocation(program, name), size, offset }))
const matrixAt = gl.getUniformLocation(program, 'm')
const glassAt = gl.getUniformLocation(program, 'glass')
gl.uniform1f(gl.getUniformLocation(program, 'cutout'), 1)
const texture = gl.createTexture()
gl.bindTexture(gl.TEXTURE_2D, texture)
for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, key, value)
const image = new Image()
image.src = '/atlas.png'
await image.decode() // Failure is an error, not a silent colour-only successful picture.
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)

function sortedGlass(data, eye) {
  const stride = F * 6
  const faces = []
  for (let at = 0; at < data.length; at += stride) {
    const center = [0, 0, 0]
    for (let n = 0; n < 6; n++) for (let axis = 0; axis < 3; axis++) center[axis] += data[at + n * F + axis] / 6
    faces.push({ at, distance: center.reduce((sum, v, axis) => sum + (v - eye[axis]) ** 2, 0) })
  }
  faces.sort((a, b) => b.distance - a.distance)
  const out = new Float32Array(data.length)
  faces.forEach(({ at }, i) => out.set(data.subarray(at, at + stride), i * stride))
  return out
}

export function render({ scene, camera, width = 512, height = 288, fov = 70 }) {
  const start = performance.now()
  const eye = ['x', 'y', 'z'].map((axis) => camera.eye[axis] - scene.origin[axis])
  const look = ['x', 'y', 'z'].map((axis) => camera.look[axis])
  const mesh = buildMesh(scene, expandRuns(scene))
  if (mesh.truncated) throw new Error('Snapshot mesh truncated')
  const meshMs = performance.now() - start
  canvas.width = width
  canvas.height = height
  gl.viewport(0, 0, width, height)
  // Outside the captured box is intentionally neutral, not generated distant scenery.
  gl.clearColor(0.55, 0.64, 0.72, 1)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
  gl.enable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE) // Eyes may be inside leaves; both sides of cutout faces remain visible.
  gl.uniformMatrix4fv(matrixAt, false, firstPersonMatrix(eye, look, width / height, fov))
  function draw(data, glass) {
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    for (const a of attributes) {
      gl.enableVertexAttribArray(a.at)
      gl.vertexAttribPointer(a.at, a.size, gl.FLOAT, false, F * 4, a.offset * 4)
    }
    gl.uniform1f(glassAt, glass ? 1 : 0)
    gl.depthMask(!glass)
    if (glass) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    } else gl.disable(gl.BLEND)
    gl.drawArrays(gl.TRIANGLES, 0, data.length / F)
    gl.deleteBuffer(buffer)
  }
  draw(mesh.opaque, false)
  draw(sortedGlass(mesh.transparent, eye), true)
  gl.depthMask(true)
  gl.finish() // Completion of this promise means atlas decoded, mesh uploaded and frame actually finished.
  const error = gl.getError()
  if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}`)
  const encodingStart = performance.now()
  const png = canvas.toDataURL('image/png').split(',')[1]
  const jpeg = canvas.toDataURL('image/jpeg', 0.65).split(',')[1]
  return {
    png, jpeg,
    phasesMs: { mesh: meshMs, draw: encodingStart - start - meshMs, encode: performance.now() - encodingStart },
    renderMs: performance.now() - start,
    faces: mesh.faces,
    renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
  }
}
