import { describe, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { GameBoy } from '../src/emulator/gameboy'

// Capture the APU's mixed stereo stream into a WAV for offline analysis.
// Uses the raw stream exactly as the worklet receives it (no post-mixer
// smoothing), so we can measure harshness / clipping / ringing.

function boot(rom: string): GameBoy {
  const gb = new GameBoy()
  gb.loadRom(new Uint8Array(readFileSync(rom)))
  return gb
}

function toWav(samples: number[], sampleRate: number): Buffer {
  const num = samples.length
  const dataSize = num * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  let off = 44
  for (let i = 0; i < num; i++) {
    let v = samples[i]
    if (v > 1) v = 1
    if (v < -1) v = -1
    buf.writeInt16LE(Math.round(v * 32767), off)
    off += 2
  }
  return buf
}

describe('capture audio', () => {
  it('writes mixed stereo WAV for a game that makes music', () => {
    const gb = boot('rom/Legend of Zelda, The - Oracle of Seasons (USA, Australia).gbc')
    gb.apu.sampleRate = 44100
    const samples: number[] = []
    // Run enough frames to get past intro into music.
    for (let f = 0; f < 400; f++) {
      gb.runFrame()
      const s = gb.apu.readSamples()
      for (let i = 0; i < s.length; i++) samples.push(s[i])
    }
    const wav = toWav(samples, 44100)
    writeFileSync('tests/capture-zelda.wav', wav)
    console.log('zelda.wav samples=' + samples.length + ' dur=' + (samples.length / 2 / 44100).toFixed(2) + 's')
  })

  it('writes mixed stereo WAV for Duke', () => {
    const gb = boot('rom/Duke Nukem (USA) (En,Fr,De,Es,It).gbc')
    gb.apu.sampleRate = 44100
    const samples: number[] = []
    for (let f = 0; f < 400; f++) {
      gb.runFrame()
      const s = gb.apu.readSamples()
      for (let i = 0; i < s.length; i++) samples.push(s[i])
    }
    const wav = toWav(samples, 44100)
    writeFileSync('tests/capture-duke.wav', wav)
    console.log('duke.wav samples=' + samples.length + ' dur=' + (samples.length / 2 / 44100).toFixed(2) + 's')
  })
})