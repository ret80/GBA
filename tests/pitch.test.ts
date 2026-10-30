import { describe, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { GameBoy } from '../src/emulator/gameboy'

// Drive the APU directly with a single channel at a target hardware frequency,
// capture the raw mixed stream, and let analyze.py measure the actual pitch.
// Target: wave CH3 = 65536/(2048-F) Hz, pulse CH1 = 131072/(2048-F) Hz.
// For a 440 Hz tone: wave needs F ≈ 1899, pulse needs F ≈ 1750.

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

function collect(gb: GameBoy, seconds: number): number[] {
  const samples: number[] = []
  const cyclesTotal = Math.round(4194304 * seconds)
  const chunk = 41943 // ~100ms
  let done = 0
  while (done < cyclesTotal) {
    const n = Math.min(chunk, cyclesTotal - done)
    gb.apu.step(n)
    done += n
    const s = gb.apu.readSamples()
    for (let i = 0; i < s.length; i++) samples.push(s[i])
  }
  return samples
}

// Wave tone: set wave RAM to a clear 32-step ramp (0..15 -> 0..FF per byte
// gives a 2-byte-per-sample triangular-ish waveform with a strong fundamental).
describe('APU pitch', () => {
  it('captures a pure wave CH3 tone targeted at 440 Hz', () => {
    const gb = new GameBoy()
    gb.apu.sampleRate = 44100
    gb.apu.writeRegister(0xFF26, 0x80) // power on
    gb.apu.writeRegister(0xFF1A, 0x80) // NR30 DAC on
    gb.apu.writeRegister(0xFF1B, 0xFF) // NR31 length
    for (let i = 0; i < 16; i++) gb.apu.waveRam[i] = (i * 0x11) & 0xFF // ramp nibbles 0..15
    gb.apu.writeRegister(0xFF1C, 0x60) // NR32 volume 100%
    gb.apu.writeRegister(0xFF1D, 0x6B) // NR33 low 8 bits of F=1899
    gb.apu.writeRegister(0xFF1E, 0x87) // NR34 trigger + freq high (0x07)
    const samples = collect(gb, 1.0)
    writeFileSync('tests/tone440-wave.wav', toWav(samples, 44100))
    console.log('tone440-wave samples=' + samples.length)
  })

  it('captures a pure pulse CH1 tone targeted at 440 Hz', () => {
    const gb = new GameBoy()
    gb.apu.sampleRate = 44100
    gb.apu.writeRegister(0xFF26, 0x80)
    gb.apu.writeRegister(0xFF10, 0x00) // NR10 sweep off
    gb.apu.writeRegister(0xFF11, 0x80) // NR11 duty 50%, length 0
    gb.apu.writeRegister(0xFF12, 0xF8) // NR12 envelope: initial vol 15, increasing (sustain)
    gb.apu.writeRegister(0xFF13, 0xD6) // NR13 low 8 bits of F=1750 (214=0xD6)
    gb.apu.writeRegister(0xFF14, 0x86) // NR14 trigger + freq high (0x06)
    const samples = collect(gb, 1.0)
    writeFileSync('tests/tone440-pulse.wav', toWav(samples, 44100))
    console.log('tone440-pulse samples=' + samples.length)
  })
})