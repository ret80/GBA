import './style.css'
import { GameBoy } from './emulator'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <div class="page">
    <h1>GameBoy Color Emulator</h1>
    <div class="emulator">
      <div id="screen-wrap">
        <canvas id="screen" width="160" height="144"></canvas>
      </div>
      <div class="controls" style="margin-top: 10px;">
        <input type="file" id="romFile" accept=".gb,.gbc,.gba,.rom" />
        <button id="startBtn">Start</button>
        <button id="pauseBtn">Pause</button>
        <button id="resetBtn">Reset</button>
        <button id="saveStateBtn">Save state</button>
        <button id="loadStateBtn">Load state</button>
        <button id="saveFileBtn">Save to file</button>
        <button id="loadFileBtn">Load from file</button>
        <input type="file" id="stateFile" accept=".gbstate" style="display:none" />
      </div>
      <div class="info" style="margin-top: 10px;">
        <p>Controls: Arrow keys (D-Pad), Z (A), X (B), Enter (Start), Backspace (Select)</p>
        <p>F5 — save state, F6 — load state</p>
      </div>
    </div>
  </div>
`

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!
const ctx = canvas.getContext('2d', { alpha: false })!
const screenWrap = document.querySelector<HTMLDivElement>('#screen-wrap')!
const romFileInput = document.querySelector<HTMLInputElement>('#romFile')!
const startBtn = document.querySelector<HTMLButtonElement>('#startBtn')!
const pauseBtn = document.querySelector<HTMLButtonElement>('#pauseBtn')!
const resetBtn = document.querySelector<HTMLButtonElement>('#resetBtn')!

const stateFileInput = document.querySelector<HTMLInputElement>('#stateFile')!
const saveStateBtn = document.querySelector<HTMLButtonElement>('#saveStateBtn')!
const loadStateBtn = document.querySelector<HTMLButtonElement>('#loadStateBtn')!
const saveFileBtn = document.querySelector<HTMLButtonElement>('#saveFileBtn')!
const loadFileBtn = document.querySelector<HTMLButtonElement>('#loadFileBtn')!

const gb = new GameBoy()
let running = false
let animationId: number = 0
let lastSave: string | null = null

const SAVE_STATE_KEY = 'gameboy-save-state'

// ---- Audio output --------------------------------------------------------
// The APU produces interleaved stereo samples during runFrame() (drained via
// gb.apu.readSamples()). We post them to an AudioWorkletProcessor ("gb-audio-
// processor") which buffers them in a ring buffer on the audio thread and
// outputs frames (L,R). Audio starts on the first user Start/click/keydown to
// satisfy autoplay policies.
const sampleRate = 44100
gb.apu.sampleRate = sampleRate
let audioCtx: AudioContext | null = null
let audioNode: AudioWorkletNode | null = null
import workletUrl from '/gb-audio-worklet.js?url'

function audioPush(samples: Float32Array): void {
  if (!audioNode || samples.length === 0) return
  audioNode.port.postMessage(samples)
}

async function audioInit(): Promise<void> {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    return
  }
  const AC: typeof AudioContext = (window.AudioContext || (window as any).webkitAudioContext)
  if (!AC) return
  const ctx = new AC({ sampleRate })
  try {
    await ctx.audioWorklet.addModule(workletUrl)
    const node = new AudioWorkletNode(ctx, 'gb-audio-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    node.connect(ctx.destination)
    audioCtx = ctx
    audioNode = node
  } catch (err) {
    console.error('AudioWorklet init failed:', err)
  }
  if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume()
}

const imageData = ctx.createImageData(160, 144)

function resizeScreen() {
  const wrap = screenWrap.getBoundingClientRect()
  const border = 4 // canvas: 2px border on each side
  const scale = Math.max(1, Math.floor(Math.min(
    (wrap.width - border) / 160,
    (wrap.height - border) / 144
  )))
  // Canvas keeps its internal 160x144 buffer; CSS scales it with
  // image-rendering: pixelated so each pixel is a crisp integer block.
  canvas.style.width = `${160 * scale}px`
  canvas.style.height = `${144 * scale}px`
}

window.addEventListener('resize', resizeScreen)
resizeScreen()

function updateScreen() {
  const framebuffer = gb.getFrameBuffer()
  for (let i = 0; i < framebuffer.length; i++) {
    const pixel = framebuffer[i]
    const idx = i * 4
    imageData.data[idx] = (pixel >> 16) & 0xFF
    imageData.data[idx + 1] = (pixel >> 8) & 0xFF
    imageData.data[idx + 2] = pixel & 0xFF
    imageData.data[idx + 3] = 0xFF
  }
  ctx.putImageData(imageData, 0, 0)
}

function runLoop() {
  if (!running) return
  gb.runFrame()
  audioPush(gb.apu.readSamples())
  updateScreen()
  animationId = requestAnimationFrame(runLoop)
}

romFileInput.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (file) {
    const arrayBuffer = await file.arrayBuffer()
    const rom = new Uint8Array(arrayBuffer)
    gb.loadRom(rom)
    console.log('ROM loaded')
    updateScreen()
  }
})

startBtn.addEventListener('click', async () => {
  await audioInit()
  if (!running) {
    running = true
    runLoop()
  }
})

pauseBtn.addEventListener('click', () => {
  running = false
  if (animationId) {
    cancelAnimationFrame(animationId)
  }
})

resetBtn.addEventListener('click', () => {
  gb.reset()
  updateScreen()
})

function saveStateToMemory() {
  try {
    lastSave = gb.saveState()
    localStorage.setItem(SAVE_STATE_KEY, lastSave)
  } catch (err) {
    console.error('Failed to save state:', err)
  }
}

function loadStateFromMemory() {
  const save = lastSave ?? localStorage.getItem(SAVE_STATE_KEY)
  if (!save) {
    alert('No saved state found')
    return
  }
  try {
    gb.loadState(save)
    // Speed up a frame so the CPU can wake from HALT and process VBlank immediately.
    // Otherwise the game appears frozen after loading (under Start it works, but
    // without a running RAF loop the display never updates).
    gb.runFrame()
    updateScreen()
  } catch (err) {
    console.error('Failed to load state:', err)
    alert('Failed to load state: ' + (err as Error).message)
  }
}

saveStateBtn.addEventListener('click', saveStateToMemory)
loadStateBtn.addEventListener('click', loadStateFromMemory)

saveFileBtn.addEventListener('click', () => {
  const save = gb.saveState()
  const blob = new Blob([save], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `gameboy-state-${Date.now()}.gbstate`
  a.click()
  URL.revokeObjectURL(url)
})

loadFileBtn.addEventListener('click', () => {
  stateFileInput.click()
})

stateFileInput.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const text = await file.text()
  try {
    gb.loadState(text.trim())
    gb.runFrame()
    updateScreen()
  } catch (err) {
    console.error('Failed to load state file:', err)
    alert('Failed to load state: ' + (err as Error).message)
  }
})

const keyMap: Record<string, number> = {
  'ArrowRight': 0,
  'ArrowLeft': 1,
  'ArrowUp': 2,
  'ArrowDown': 3,
  'z': 4,
  'Z': 4,
  'x': 5,
  'X': 5,
  'Backspace': 6,
  'Enter': 7,
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'F5' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    saveStateToMemory()
    return
  }
  if (e.key === 'F6' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault()
    loadStateFromMemory()
    return
  }
  if (keyMap[e.key] !== undefined) {
    // Make sure the emulator is running so the game can wake from HALT
    if (!running) {
      running = true
      runLoop()
    }
    audioInit()
    e.preventDefault()
    gb.joypad.setButton(keyMap[e.key], true)
  }
})

document.addEventListener('keyup', (e) => {
  if (keyMap[e.key] !== undefined) {
    e.preventDefault()
    gb.joypad.setButton(keyMap[e.key], false)
  }
})

updateScreen()

