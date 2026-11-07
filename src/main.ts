import './style.css'
import { GameBoy } from './emulator'
import { Gba, isGbaRom } from './emulator/gba/gba'
import { GBA_BUTTONS } from './emulator/gba/keypad'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <div class="page">
    <h1>Game Boy / Game Boy Advance Emulator</h1>
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
        <input type="file" id="stateFile" accept=".gbstate,.gbastate" style="display:none" />
      </div>
      <div class="info" style="margin-top: 10px;">
        <p id="romInfo">Load a .gb / .gbc / .gba ROM to start.</p>
        <p>GB/GBC: Arrows (D-Pad), Z (A), X (B), Enter (Start), Backspace (Select)</p>
        <p>GBA: Arrows (D-Pad), Z (A), X (B), A (L), S (R), Enter (Start), Backspace (Select)</p>
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
const romInfo = document.querySelector<HTMLParagraphElement>('#romInfo')!

const stateFileInput = document.querySelector<HTMLInputElement>('#stateFile')!
const saveStateBtn = document.querySelector<HTMLButtonElement>('#saveStateBtn')!
const loadStateBtn = document.querySelector<HTMLButtonElement>('#loadStateBtn')!
const saveFileBtn = document.querySelector<HTMLButtonElement>('#saveFileBtn')!
const loadFileBtn = document.querySelector<HTMLButtonElement>('#loadFileBtn')!

/** Common surface implemented by both cores. */
interface EmulatorDevice {
  readonly screenWidth: number
  readonly screenHeight: number
  readonly joypad: { setButton(button: number, pressed: boolean): void }
  readonly apu: { sampleRate: number; readSamples(): Float32Array }
  loadRom(rom: Uint8Array): void
  reset(): void
  runFrame(): void
  getFrameBuffer(): Uint32Array
  saveState(): string
  loadState(state: string): void
  readonly cartridge?: { title: string }
  readonly saveType?: string
}

let device: EmulatorDevice = new GameBoy()
let isGba = false
let running = false
let animationId = 0
let lastSave: string | null = null

const GB_SAVE_KEY = 'gameboy-save-state'
const GBA_SAVE_KEY = 'gba-save-state'

function saveKey(): string {
  return isGba ? GBA_SAVE_KEY : GB_SAVE_KEY
}

// ---- Audio output --------------------------------------------------------
// The APU produces interleaved stereo samples during runFrame() (drained via
// `device.apu.readSamples()`), which are posted to an AudioWorkletProcessor
// ("gb-audio-processor") that buffers them on the audio thread. Audio starts
// on the first user gesture to satisfy autoplay policies. The GBA core
// currently exposes a silent APU stub, so this is a no-op for GBA titles.
const sampleRate = 44100
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
  const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext
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

// ---- Screen --------------------------------------------------------------

let imageData = ctx.createImageData(device.screenWidth, device.screenHeight)

function resizeScreen() {
  const wrap = screenWrap.getBoundingClientRect()
  const border = 4
  const scale = Math.max(1, Math.floor(Math.min(
    (wrap.width - border) / device.screenWidth,
    (wrap.height - border) / device.screenHeight
  )))
  canvas.style.width = `${device.screenWidth * scale}px`
  canvas.style.height = `${device.screenHeight * scale}px`
}

window.addEventListener('resize', resizeScreen)

function configureScreen() {
  canvas.width = device.screenWidth
  canvas.height = device.screenHeight
  imageData = ctx.createImageData(device.screenWidth, device.screenHeight)
  resizeScreen()
}

function updateScreen() {
  const framebuffer = device.getFrameBuffer()
  const data = imageData.data
  for (let i = 0; i < framebuffer.length; i++) {
    const pixel = framebuffer[i]
    const idx = i * 4
    data[idx] = (pixel >> 16) & 0xff
    data[idx + 1] = (pixel >> 8) & 0xff
    data[idx + 2] = pixel & 0xff
    data[idx + 3] = 0xff
  }
  ctx.putImageData(imageData, 0, 0)
}

function runLoop() {
  if (!running) return
  device.runFrame()
  audioPush(device.apu.readSamples())
  updateScreen()
  animationId = requestAnimationFrame(runLoop)
}

// ---- ROM loading ---------------------------------------------------------

function createDevice(rom: Uint8Array, fileName: string): EmulatorDevice {
  const gba = isGbaRom(rom, fileName)
  if (gba) return new Gba()
  return new GameBoy()
}

romFileInput.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const arrayBuffer = await file.arrayBuffer()
  const rom = new Uint8Array(arrayBuffer)

  pause()
  isGba = isGbaRom(rom, file.name)
  device = createDevice(rom, file.name)
  device.apu.sampleRate = sampleRate
  device.loadRom(rom)
  lastSave = null
  configureScreen()
  updateScreen()

  const label = isGba ? 'Game Boy Advance' : 'Game Boy / Color'
  const title = device.cartridge?.title?.trim() || file.name
  romInfo.textContent = `${label} — ${title}`
  console.log('ROM loaded:', file.name, '-', label)
})

function pause() {
  running = false
  if (animationId) cancelAnimationFrame(animationId)
  animationId = 0
}

startBtn.addEventListener('click', async () => {
  await audioInit()
  if (!running) {
    running = true
    runLoop()
  }
})

pauseBtn.addEventListener('click', pause)

resetBtn.addEventListener('click', () => {
  device.reset()
  updateScreen()
})

// ---- Save states ---------------------------------------------------------

function saveStateToMemory() {
  try {
    lastSave = device.saveState()
    localStorage.setItem(saveKey(), lastSave)
  } catch (err) {
    console.error('Failed to save state:', err)
  }
}

function loadStateFromMemory() {
  const save = lastSave ?? localStorage.getItem(saveKey())
  if (!save) {
    alert('No saved state found')
    return
  }
  try {
    device.loadState(save)
    // Advance one frame so the CPU can wake from HALT and process VBlank.
    device.runFrame()
    updateScreen()
  } catch (err) {
    console.error('Failed to load state:', err)
    alert('Failed to load state: ' + (err as Error).message)
  }
}

saveStateBtn.addEventListener('click', saveStateToMemory)
loadStateBtn.addEventListener('click', loadStateFromMemory)

function stateExtension(): string {
  return isGba ? 'gbastate' : 'gbstate'
}

saveFileBtn.addEventListener('click', () => {
  const save = device.saveState()
  const blob = new Blob([save], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${isGba ? 'gba' : 'gameboy'}-state-${Date.now()}.${stateExtension()}`
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
    device.loadState(text.trim())
    device.runFrame()
    updateScreen()
  } catch (err) {
    console.error('Failed to load state file:', err)
    alert('Failed to load state: ' + (err as Error).message)
  }
})

// ---- Input ---------------------------------------------------------------

const GB_KEYS: Record<string, number> = {
  ArrowRight: 0,
  ArrowLeft: 1,
  ArrowUp: 2,
  ArrowDown: 3,
  z: 4,
  Z: 4,
  x: 5,
  X: 5,
  Backspace: 6,
  Enter: 7,
}

const GBA_KEYS: Record<string, number> = {
  ArrowRight: GBA_BUTTONS.RIGHT,
  ArrowLeft: GBA_BUTTONS.LEFT,
  ArrowUp: GBA_BUTTONS.UP,
  ArrowDown: GBA_BUTTONS.DOWN,
  z: GBA_BUTTONS.A,
  Z: GBA_BUTTONS.A,
  x: GBA_BUTTONS.B,
  X: GBA_BUTTONS.B,
  a: GBA_BUTTONS.L,
  A: GBA_BUTTONS.L,
  s: GBA_BUTTONS.R,
  S: GBA_BUTTONS.R,
  Backspace: GBA_BUTTONS.SELECT,
  Enter: GBA_BUTTONS.START,
}

function buttonFor(key: string): number | undefined {
  return (isGba ? GBA_KEYS : GB_KEYS)[key]
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
  const button = buttonFor(e.key)
  if (button !== undefined) {
    if (!running) {
      running = true
      runLoop()
    }
    audioInit()
    e.preventDefault()
    device.joypad.setButton(button, true)
  }
})

document.addEventListener('keyup', (e) => {
  const button = buttonFor(e.key)
  if (button !== undefined) {
    e.preventDefault()
    device.joypad.setButton(button, false)
  }
})

configureScreen()
updateScreen()
