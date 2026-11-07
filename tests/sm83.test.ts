import { describe, it, expect } from 'vitest'
import { GameBoy } from '../src/emulator/gameboy'
import { CB_OPS, MAIN_OPS } from '../src/emulator/sm83/optable'

function program(gb: GameBoy, bytes: number[], start = 0xc000): void {
  bytes.forEach((byte, i) => gb.memory.write8(start + i, byte))
  gb.cpu.PC = start
}

describe('SM83 table-driven core', () => {
  it('decodes every opcode in both pages', () => {
    expect(MAIN_OPS).toHaveLength(256)
    expect(CB_OPS).toHaveLength(256)
    for (const table of [MAIN_OPS, CB_OPS]) {
      for (const entry of table) {
        expect(entry).toBeDefined()
        expect(typeof entry.execute).toBe('function')
        expect(entry.cycles).toBeGreaterThan(0)
      }
    }
  })

  it('runs a small arithmetic program', () => {
    const gb = new GameBoy()
    gb.reset()
    // LD A,0x45 ; ADD A,0x38 ; DAA ; LD (0xC100),A ; HALT
    program(gb, [0x3e, 0x45, 0xc6, 0x38, 0x27, 0xea, 0x00, 0xc1, 0x76])
    for (let i = 0; i < 5; i++) gb.cpu.step()
    expect(gb.cpu.A).toBe(0x83)
    expect(gb.memory.read8(0xc100)).toBe(0x83)
    expect(gb.cpu.halted).toBe(true)
  })

  it('sets half-carry and zero flags on INC/DEC', () => {
    const gb = new GameBoy()
    gb.reset()
    gb.cpu.B = 0x0f
    gb.cpu.PC = 0xc000
    gb.memory.write8(0xc000, 0x04) // INC B
    gb.cpu.step()
    expect(gb.cpu.B).toBe(0x10)
    expect(gb.cpu.F & 0x20).toBe(0x20)
    expect(gb.cpu.F & 0x80).toBe(0)

    gb.cpu.F = 0
    gb.cpu.C = 0xff
    gb.cpu.PC = 0xc000
    gb.memory.write8(0xc000, 0x0d) // DEC C
    gb.cpu.step()
    expect(gb.cpu.C).toBe(0xfe)
    expect(gb.cpu.F & 0x80).toBe(0)
    expect(gb.cpu.F & 0x40).toBe(0x40)
  })

  it('implements the CB page (rotate, bit, set, res)', () => {
    const gb = new GameBoy()
    gb.reset()
    gb.cpu.B = 0x81
    gb.cpu.PC = 0xc000
    // CB 00: RLC B -> 0x03, carry set
    gb.memory.write8(0xc000, 0xcb)
    gb.memory.write8(0xc001, 0x00)
    gb.cpu.step()
    expect(gb.cpu.B).toBe(0x03)
    expect(gb.cpu.F & 0x10).toBe(0x10)

    gb.cpu.PC = 0xc000
    gb.memory.write8(0xc001, 0x78) // BIT 7,B (B=0x03 -> bit clear)
    gb.cpu.step()
    expect(gb.cpu.F & 0x80).toBe(0x80)
    expect(gb.cpu.F & 0x20).toBe(0x20)

    gb.cpu.PC = 0xc000
    gb.memory.write8(0xc001, 0xf8) // SET 7,B
    gb.cpu.step()
    expect(gb.cpu.B).toBe(0x83)

    gb.cpu.PC = 0xc000
    gb.memory.write8(0xc001, 0xb8) // RES 7,B
    gb.cpu.step()
    expect(gb.cpu.B).toBe(0x03)
  })

  it('takes conditional relative jumps', () => {
    const gb = new GameBoy()
    gb.reset()
    // XOR A ; JR Z,+2 ; LD B,1 ; LD B,2 ; HALT
    program(gb, [0xaf, 0x28, 0x01, 0x06, 0x01, 0x06, 0x02, 0x76])
    for (let i = 0; i < 4; i++) gb.cpu.step()
    expect(gb.cpu.B).toBe(2)
  })

  it('adds SP with correct half-carry and carry semantics', () => {
    const gb = new GameBoy()
    gb.reset()
    gb.cpu.SP = 0xffff
    gb.cpu.PC = 0xc000
    gb.memory.write8(0xc000, 0xe8) // ADD SP,-1
    gb.memory.write8(0xc001, 0xff)
    gb.cpu.step()
    expect(gb.cpu.SP).toBe(0xfffe)
    expect(gb.cpu.F & 0x10).toBe(0x10)
    expect(gb.cpu.F & 0x20).toBe(0x20)
  })
})

describe('SM83 opcode table contents', () => {
  it('has no unimplemented holes apart from the documented illegal opcodes', () => {
    const illegal = new Set([0xd3, 0xdb, 0xdd, 0xe3, 0xe4, 0xeb, 0xec, 0xed, 0xf4, 0xfc, 0xfd])
    const holes: number[] = []
    MAIN_OPS.forEach((entry, opcode) => {
      if (entry.mnemonic.startsWith('DB ') && !illegal.has(opcode)) holes.push(opcode)
    })
    expect(holes).toEqual([])
  })

  it('matches reference mnemonics and cycle counts', () => {
    const cases: [number, string, number][] = [
      [0x00, 'NOP', 4],
      [0x08, 'LD (a16),SP', 20],
      [0x22, 'LD (HL+),A', 8],
      [0x36, 'LD (HL),d8', 12],
      [0x3e, 'LD A,d8', 8],
      [0x76, 'HALT', 4],
      [0x7e, 'LD A,(HL)', 8],
      [0xc3, 'JP a16', 16],
      [0xcd, 'CALL a16', 24],
      [0xe0, 'LDH (a8),A', 12],
      [0xf9, 'LD SP,HL', 8],
    ]
    for (const [opcode, mnemonic, cycles] of cases) {
      expect(MAIN_OPS[opcode].mnemonic).toBe(mnemonic)
      expect(MAIN_OPS[opcode].cycles).toBe(cycles)
    }
  })
})
