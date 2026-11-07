import { describe, it, expect } from 'vitest'
import {
  Arm7tdmi,
  ARM_C,
  ARM_T,
  ARM_Z,
  IRQ_RETURN_MARKER,
  type ArmBus,
  type ArmHooks,
} from '../src/emulator/gba/arm7tdmi'

class TestBus implements ArmBus {
  mem = new Uint8Array(0x10000)

  read8(a: number): number {
    return this.mem[a & 0xffff]
  }
  read16(a: number): number {
    return this.read8(a) | (this.read8(a + 1) << 8)
  }
  read32(a: number): number {
    return (this.read16(a) | (this.read16(a + 2) << 16)) >>> 0
  }
  write8(a: number, v: number): void {
    this.mem[a & 0xffff] = v & 0xff
  }
  write16(a: number, v: number): void {
    this.write8(a, v & 0xff)
    this.write8(a + 1, (v >> 8) & 0xff)
  }
  write32(a: number, v: number): void {
    this.write16(a, v & 0xffff)
    this.write16(a + 2, (v >>> 16) & 0xffff)
  }
}

const hooks: ArmHooks = {
  swi: () => {},
  haltWake: () => false,
  irqPending: () => false,
  enterIrq: () => {},
  leaveIrq: () => {},
}

function makeCpu(): { cpu: Arm7tdmi; bus: TestBus } {
  const bus = new TestBus()
  const cpu = new Arm7tdmi(bus, hooks)
  cpu.r[15] = 0x100
  return { cpu, bus }
}

function run(cpu: Arm7tdmi, count: number): void {
  for (let i = 0; i < count; i++) cpu.step()
}

describe('ARM7TDMI ARM instructions', () => {
  it('executes data processing and flags', () => {
    const { cpu } = makeCpu()
    // MOV r0,#5 ; ADD r1,r0,#3 ; SUB r2,r1,#1 ; CMP r2,#7 ; MOVEQ r3,#1
    const program = [0xe3a00005, 0xe2801003, 0xe2412001, 0xe3520007, 0x03a03001]
    program.forEach((instr, i) => cpu.bus.write32(0x100 + i * 4, instr))

    run(cpu, 5)
    expect(cpu.r[0]).toBe(5)
    expect(cpu.r[1]).toBe(8)
    expect(cpu.r[2]).toBe(7)
    expect(cpu.r[3]).toBe(1) // EQ taken because CMP set Z
    expect(cpu.cpsr & ARM_Z).toBe(ARM_Z)
  })

  it('does not update flags when S is clear', () => {
    const { cpu } = makeCpu()
    cpu.cpsr = 0
    cpu.bus.write32(0x100, 0xe3a00005) // MOV r0,#5
    cpu.bus.write32(0x104, 0xe2801003) // ADD r1,r0,#3 (no S)
    run(cpu, 2)
    expect(cpu.cpsr & (ARM_Z | ARM_C)).toBe(0)
  })

  it('handles carries and overflow', () => {
    const { cpu } = makeCpu()
    cpu.bus.write32(0x100, 0xe3e00000) // MVN r0,#0 -> 0xFFFFFFFF
    cpu.bus.write32(0x104, 0xe2901001) // ADDS r1,r0,#1 -> 0, carry
    run(cpu, 2)
    expect(cpu.r[1]).toBe(0)
    expect(cpu.cpsr & ARM_Z).toBe(ARM_Z)
    expect(cpu.cpsr & ARM_C).toBe(ARM_C)
  })

  it('loads and stores words with pre/post indexing', () => {
    const { cpu, bus } = makeCpu()
    bus.write32(0x200, 0xdeadbeef)
    const program = [
      0xe3a01000 | 0x200, // MOV r1,#0x200 (imm8 rotated: use ldr instead)
    ]
    // ldr r0,=0x200 via literal
    cpu.bus.write32(0x100, 0xe59f0010) // ldr r0,[pc,#16] -> 0x118
    cpu.bus.write32(0x104, 0xe5902000) // ldr r2,[r0]
    cpu.bus.write32(0x108, 0xe2801004) // add r1,r0,#4
    cpu.bus.write32(0x10c, 0xe5812004) // str r2,[r1,#4] -> 0x208
    cpu.bus.write32(0x110, 0xe4903004) // ldr r3,[r0],#4
    cpu.bus.write32(0x118, 0x200)
    run(cpu, 5)
    expect(cpu.r[2]).toBe(0xdeadbeef)
    expect(bus.read32(0x208)).toBe(0xdeadbeef)
    expect(cpu.r[3]).toBe(0xdeadbeef)
    expect(cpu.r[0]).toBe(0x204)
    void program
  })

  it('transfers blocks with LDM/STM', () => {
    const { cpu, bus } = makeCpu()
    cpu.r[0] = 0x300
    cpu.r[1] = 0x11111111
    cpu.r[2] = 0x22222222
    cpu.bus.write32(0x100, 0xe8a00006) // stmia r0!, {r1,r2}
    cpu.bus.write32(0x104, 0xe8b00018) // ldmia r0!, {r3,r4}
    cpu.step()
    cpu.r[0] = 0x300
    cpu.step()
    expect(bus.read32(0x300)).toBe(0x11111111)
    expect(bus.read32(0x304)).toBe(0x22222222)
    expect(cpu.r[3]).toBe(0x11111111)
    expect(cpu.r[4]).toBe(0x22222222)
    expect(cpu.r[0]).toBe(0x308)
  })

  it('branches with link and multiplies', () => {
    const { cpu } = makeCpu()
    cpu.bus.write32(0x100, 0xeb000001) // bl 0x10c
    cpu.bus.write32(0x10c, 0xe3a00007) // mov r0,#7
    cpu.bus.write32(0x110, 0xe3a01006) // mov r1,#6
    cpu.bus.write32(0x114, 0xe0000291) // mul r0,r1,r2
    cpu.r[2] = 9
    run(cpu, 4)
    expect(cpu.r[14]).toBe(0x104)
    expect(cpu.r[0]).toBe(54)
  })

  it('loads and stores halfwords and signed bytes', () => {
    const { cpu, bus } = makeCpu()
    bus.write16(0x400, 0xbeef)
    bus.write8(0x402, 0x80)
    cpu.r[1] = 0x400
    cpu.bus.write32(0x100, 0xe1d100b0) // ldrh r0,[r1]
    cpu.bus.write32(0x104, 0xe1d120d2) // ldrsb r2,[r1,#2]
    cpu.bus.write32(0x108, 0xe3a03042) // mov r3,#0x42
    cpu.bus.write32(0x10c, 0xe1c130be) // strh r3,[r1,#14]
    run(cpu, 4)
    expect(cpu.r[0]).toBe(0xbeef)
    expect(cpu.r[2]).toBe(0xffffff80)
    expect(bus.read16(0x40e)).toBe(0x42)
  })
})

describe('ARM7TDMI Thumb instructions', () => {
  function makeThumb() {
    const { cpu, bus } = makeCpu()
    cpu.cpsr = (cpu.cpsr | ARM_T) >>> 0
    return { cpu, bus }
  }

  it('executes mov/add/lsl/cmp and conditional branch', () => {
    const { cpu, bus } = makeThumb()
    const program = [
      0x2007, // mov r0,#7
      0x3005, // add r0,#5
      0x0080, // lsl r0,r0,#2
      0x2830, // cmp r0,#0x30
      0xd000, // beq +0
      0x2100, // mov r1,#0 (skipped)
      0x2101, // mov r1,#1
    ]
    program.forEach((instr, i) => bus.write16(0x100 + i * 2, instr))
    run(cpu, 6)
    expect(cpu.r[0]).toBe(0x30)
    expect(cpu.r[1]).toBe(1)
  })

  it('pushes, pops and branches with link', () => {
    const { cpu, bus } = makeThumb()
    cpu.r[13] = 0x800
    cpu.r[0] = 0x1234
    const program = [
      0xb501, // push {r0,lr}
      0x2002, // mov r0,#2
      0xbd01, // pop {r0,pc}
    ]
    program.forEach((instr, i) => bus.write16(0x100 + i * 2, instr))
    run(cpu, 3)
    expect(cpu.r[0]).toBe(0x1234)
    expect(cpu.r[13]).toBe(0x800)
  })

  it('switches to ARM with bx', () => {
    const { cpu, bus } = makeThumb()
    cpu.r[0] = 0x200
    bus.write16(0x100, 0x4700) // bx r0
    bus.write32(0x200, 0xe3a05001) // mov r5,#1 (ARM)
    run(cpu, 2)
    expect(cpu.thumb).toBe(false)
    expect(cpu.r[5]).toBe(1)
  })
})

describe('ARM7TDMI exceptions and BIOS hooks', () => {
  it('calls the SWI hook and returns', () => {
    const bus = new TestBus()
    let called = 0
    const localHooks: ArmHooks = { ...hooks, swi: () => (called += 1) }
    const cpu = new Arm7tdmi(bus, localHooks)
    cpu.r[15] = 0x100
    bus.write32(0x100, 0xef060000) // swi 6
    bus.write32(0x104, 0xe3a00009) // mov r0,#9
    cpu.step()
    cpu.step()
    expect(called).toBe(1)
    expect(cpu.r[0]).toBe(9)
  })

  it('halts until an interrupt is requested', () => {
    let wake = false
    const bus = new TestBus()
    const localHooks: ArmHooks = { ...hooks, haltWake: () => wake }
    const cpu = new Arm7tdmi(bus, localHooks)
    cpu.halted = true
    cpu.r[15] = 0x100
    bus.write32(0x100, 0xe3a00005)
    cpu.step()
    expect(cpu.r[0]).toBe(0)
    wake = true
    cpu.step()
    expect(cpu.r[0]).toBe(5)
  })

  it('restores control when the HLE IRQ handler returns to the marker', () => {
    const bus = new TestBus()
    const cpu = new Arm7tdmi(bus, hooks)
    cpu.r[15] = IRQ_RETURN_MARKER
    const before = cpu.cpsr
    cpu.step()
    expect(cpu.cpsr).toBe(before)
  })
})

describe('ARM decoding independence from operand bits', () => {
  it('loads with an offset whose low bits look like an opcode', () => {
    const { cpu, bus } = makeCpu()
    // ldr r0,[pc,#0x94]: the offset sets bits 7 and 4, which must not change
    // the decoded instruction class.
    bus.write32(0x19c, 0xdeadbeef)
    cpu.bus.write32(0x100, 0xe59f0094)
    cpu.step()
    expect(cpu.r[0]).toBe(0xdeadbeef)
  })

  it('handles data processing with an immediate shift', () => {
    const { cpu } = makeCpu()
    cpu.r[1] = 5
    cpu.bus.write32(0x100, 0xe1a01081) // mov r1,r1,lsl #1
    cpu.step()
    expect(cpu.r[1]).toBe(10)
  })
})

describe('ARM7TDMI long multiplies', () => {
  it('computes 64-bit unsigned products exactly', () => {
    const { cpu } = makeCpu()
    cpu.r[2] = 0xffffffff
    cpu.r[3] = 0xffffffff
    cpu.bus.write32(0x100, 0xe0810392) // umull r0,r1,r2,r3
    cpu.step()
    expect(cpu.r[0]).toBe(0x00000001)
    expect(cpu.r[1]).toBe(0xfffffffe)
  })

  it('computes 64-bit signed products exactly', () => {
    const { cpu } = makeCpu()
    cpu.r[2] = 0xffffffff // -1
    cpu.r[3] = 0xffffffff // -1
    cpu.bus.write32(0x100, 0xe0c10392) // smull r0,r1,r2,r3
    cpu.step()
    expect(cpu.r[0]).toBe(1)
    expect(cpu.r[1]).toBe(0)
  })
})
