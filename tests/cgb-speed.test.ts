import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { GameBoy } from '../src/emulator/gameboy'

// Regression: Zelda: Oracle of Seasons (CGB) used to show a white/grey screen
// because the CPU was stuck in the CGB speed-switch poll loop at 0x4084:
//   LDH A,(0x4D)  RLCA  JR NC,0x4084   -- waits for KEY1 bit7 == 1
// The old STOP handler cleared KEY1 bit7, so the poll never exited.
// After the fix the game boots, double-speed switches, and renders content.
describe('Zelda Oracle of Seasons boots (regression)', () => {
  it('progresses past the speed-switch poll and renders non-blank content', () => {
    const rom = new Uint8Array(readFileSync('rom/Legend of Zelda, The - Oracle of Seasons (USA, Australia).gbc'))
    const gb = new GameBoy()
    gb.loadRom(rom)

    const pcCount = new Map<number, number>()
    let total = 0
    const orig = gb.cpu.step.bind(gb.cpu)
    gb.cpu.step = ((() => {
      const pc = gb.cpu.PC
      const r = orig()
      pcCount.set(pc, (pcCount.get(pc) || 0) + 1)
      total++
      return r
    }) as any)

    for (let f = 0; f < 400; f++) gb.runFrame()

    // The speed-switch poll loop must NOT dominate execution.
    const loopTime =
      (pcCount.get(0x4084) || 0) + (pcCount.get(0x4086) || 0) + (pcCount.get(0x4087) || 0)
    expect(loopTime / total).toBeLessThan(0.05)

    // The game must switch to double speed (it requests it during boot).
    expect(gb.cpu.doubleSpeed).toBe(true)

    // Framebuffer must not be a single blank/white color.
    const fb = gb.getFrameBuffer()
    const colors = new Set<number>()
    for (let i = 0; i < fb.length; i++) colors.add(fb[i])
    expect(colors.size).toBeGreaterThan(1)
  })
})
