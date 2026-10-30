import { describe, it, expect } from 'vitest'
import { GameBoy } from '../src/emulator/gameboy'

describe('Joypad interrupt', () => {
  it('fires on button press when the group is selected', () => {
    const gb = new GameBoy()
    gb.reset()
    // Select button group (P1 bit5=0)
    gb.joypad.write(0x00)
    const ifBefore = gb.interrupts.IF & 0x10
    gb.joypad.setButton(7, true) // START
    const ifAfter = gb.interrupts.IF & 0x10
    expect(ifBefore).toBe(0)
    expect(ifAfter).toBe(0x10)
  })

  it('fires when a held button becomes selected via P1 write (falling edge)', () => {
    const gb = new GameBoy()
    gb.reset()
    // Press a button while the group is NOT selected (no interrupt yet)
    gb.joypad.write(0x20) // select dpad only, not buttons
    gb.joypad.setButton(7, true) // START (button), but group not selected
    expect(gb.interrupts.IF & 0x10).toBe(0)
    // Now select the button group while the button is held -> falling edge
    gb.joypad.write(0x00)
    expect(gb.interrupts.IF & 0x10).toBe(0x10)
  })

  it('does not fire on release', () => {
    const gb = new GameBoy()
    gb.reset()
    gb.joypad.write(0x00)
    gb.joypad.setButton(7, true)
    const ifAfterPress = gb.interrupts.IF & 0x10
    gb.interrupts.IF &= ~0x10
    gb.joypad.setButton(7, false)
    expect(gb.interrupts.IF & 0x10).toBe(0)
    expect(ifAfterPress).toBe(0x10)
  })
})