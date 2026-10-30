import { describe, it, expect } from 'vitest'
import { GameBoy } from '../src/emulator/gameboy'

describe('APU sample generation', () => {
  it('produces samples when a channel is triggered', () => {
    const gb = new GameBoy()
    gb.reset()
    const apu: any = gb.apu

    // Enable sound on (NR52 bit7), master vol full (NR50), pan both (NR51)
    apu.writeRegister(0xFF26, 0x80)
    apu.writeRegister(0xFF24, 0x77)
    apu.writeRegister(0xFF25, 0xFF)

    // Channel 2 (no sweep): duty 50%, volume 15, freq low, trigger
    apu.writeRegister(0xFF16, 0x80) // duty 50
    apu.writeRegister(0xFF17, 0xF0) // DAC on, vol 15, no envelope
    apu.writeRegister(0xFF18, 0x00) // freq low
    apu.writeRegister(0xFF19, 0x87 | 0x80) // freq high bit0 + trigger

    // Run a bunch of cycles; should generate non-silent samples
    const before = apu.readSamples()
    apu.step(8192)
    const samples = apu.readSamples()
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.length % 2).toBe(0)

    // At least one sample should be non-zero (channel is sounding)
    let nonzero = 0
    for (let i = 0; i < samples.length; i++) if (samples[i] !== 0) nonzero++
    expect(nonzero).toBeGreaterThan(0)
  })

  it('silence when sound is powered off', () => {
    const gb = new GameBoy()
    gb.reset()
    const apu: any = gb.apu
    apu.step(8192)
    const samples = apu.readSamples()
    // With NR52 bit7 cleared (default reset), no sound -> silent
    const max = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(max).toBe(0)
  })
})