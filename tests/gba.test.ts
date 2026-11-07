import { describe, it, expect } from 'vitest'
import { Gba, isGbaRom } from '../src/emulator/gba/gba'

function makeRom(words: number[], literals: [number, number][] = []): Uint8Array {
  const rom = new Uint8Array(0x1000)
  const view = new DataView(rom.buffer)
  words.forEach((word, i) => view.setUint32(i * 4, word, true))
  for (const [offset, value] of literals) view.setUint32(offset, value, true)
  return rom
}

/** Sets DISPCNT to mode 3 with BG2 enabled and paints VRAM pixel 0 red. */
const RENDER_ROM = makeRom(
  [
    0xe59f0014, // ldr r0,[pc,#20]  -> 0x1c: 0x04000000
    0xe59f1014, // ldr r1,[pc,#20]  -> 0x20: 0x00000403
    0xe5801000, // str r1,[r0]      ; DISPCNT = mode 3 + BG2
    0xe59f0010, // ldr r0,[pc,#16]  -> 0x24: 0x06000000
    0xe59f1010, // ldr r1,[pc,#16]  -> 0x28: 0x0000001f
    0xe1c010b0, // strh r1,[r0]     ; first pixel red
    0xeafffffe, // b .
  ],
  [
    [0x1c, 0x04000000],
    [0x20, 0x00000403],
    [0x24, 0x06000000],
    [0x28, 0x0000001f],
  ]
)

describe('GBA memory map', () => {
  it('mirrors EWRAM, IWRAM, palette, VRAM and OAM', () => {
    const gba = new Gba()
    gba.loadRom(makeRom([0xeafffffe]))
    gba.bus.write8(0x02000000, 0x12)
    expect(gba.bus.read8(0x02040000)).toBe(0x12)
    gba.bus.write16(0x03000000, 0xbeef)
    expect(gba.bus.read16(0x03008000)).toBe(0xbeef)
    gba.bus.write16(0x05000002, 0x7fff)
    expect(gba.bus.read16(0x05000402)).toBe(0x7fff)
    gba.bus.write32(0x06010000, 0xdeadbeef)
    expect(gba.bus.read32(0x06010000)).toBe(0xdeadbeef)
    gba.bus.write16(0x07000000, 0x1234)
    expect(gba.bus.read16(0x07000000)).toBe(0x1234)
  })

  it('mirrors ROM reads across the 32 MiB window', () => {
    // Pad to 32 KiB so the modulo mirroring is easy to verify.
    const rom = new Uint8Array(0x8000)
    rom[0] = 0xaa
    rom[0x7fff] = 0xbb
    const gba = new Gba()
    gba.loadRom(rom)
    expect(gba.bus.read8(0x08000000)).toBe(0xaa)
    expect(gba.bus.read8(0x08008000)).toBe(0xaa)
    expect(gba.bus.read8(0x08007fff)).toBe(0xbb)
  })
})

describe('GBA machine', () => {
  it('detects GBA ROMs', () => {
    const rom = new Uint8Array(0x200)
    rom[0xb2] = 0x96
    expect(isGbaRom(rom)).toBe(true)
    expect(isGbaRom(new Uint8Array(0x200), 'game.gba')).toBe(true)
    expect(isGbaRom(new Uint8Array(0x200), 'game.gbc')).toBe(false)
  })

  it('boots a ROM, programs the PPU and renders mode 3 pixels', () => {
    const gba = new Gba()
    gba.loadRom(RENDER_ROM)
    gba.runFrame()

    expect(gba.ppu.dispcnt).toBe(0x0403)
    expect(gba.bus.read16(0x06000000)).toBe(0x001f)
    expect(gba.getFrameBuffer()[0]).toBe(0xfff80000)
  })

  it('runs BIOS Div through SWI', () => {
    const rom = makeRom([
      0xe3a00014, // mov r0,#20
      0xe3a01003, // mov r1,#3
      0xef060000, // swi 6 (Div)
      0xeafffffe, // b .
    ])
    const gba = new Gba()
    gba.loadRom(rom)
    for (let i = 0; i < 3; i++) gba.cpu.step()
    expect(gba.cpu.r[0]).toBe(6)
    expect(gba.cpu.r[1]).toBe(2)
    expect(gba.cpu.r[3]).toBe(6)
  })

  it('raises timer IRQs on overflow', () => {
    const gba = new Gba()
    gba.loadRom(makeRom([0xeafffffe]))
    gba.timers.writeIO(0x100, 0xfffe)
    gba.timers.writeIO(0x102, 0x00c0) // enable, IRQ, prescaler 1
    gba.timers.step(2)
    expect(gba.irq.if_ & (1 << 3)).toBe(1 << 3)
    expect(gba.timers.channels[0].counter).toBe(0xfffe)
  })

  it('performs immediate DMA transfers', () => {
    const gba = new Gba()
    gba.loadRom(makeRom([0xeafffffe]))
    gba.bus.write32(0x02000000, 0x12345678)
    gba.bus.write32(0x02000004, 0x9abcdef0)
    // DMA3: SAD=0x02000000, DAD=0x02000100, count=2 words, 32-bit increment.
    gba.dma.writeIO(0xd4, 0x0000)
    gba.dma.writeIO(0xd6, 0x0200)
    gba.dma.writeIO(0xd8, 0x0100)
    gba.dma.writeIO(0xda, 0x0200)
    gba.dma.writeIO(0xdc, 0x0002)
    gba.dma.writeIO(0xde, 0x8400)
    expect(gba.bus.read32(0x02000100)).toBe(0x12345678)
    expect(gba.bus.read32(0x02000104)).toBe(0x9abcdef0)
  })

  it('detects SRAM save chips from ROM markers', () => {
    const rom = makeRom([0xeafffffe])
    const marker = 'SRAM_V113'
    for (let i = 0; i < marker.length; i++) rom[0x200 + i] = marker.charCodeAt(i)
    rom[0xb2] = 0x96
    const gba = new Gba()
    gba.loadRom(rom)
    expect(gba.saveType).toBe('sram')
    gba.cart.write8(0x10, 0x5a)
    expect(gba.cart.read8(0x10)).toBe(0x5a)
  })

  it('round-trips save states', () => {
    const gba = new Gba()
    gba.loadRom(RENDER_ROM)
    gba.runFrame()
    gba.bus.write8(0x02000000, 0x77)
    const state = gba.saveState()

    gba.bus.write8(0x02000000, 0x00)
    gba.ppu.dispcnt = 0
    gba.loadState(state)
    expect(gba.bus.read8(0x02000000)).toBe(0x77)
    expect(gba.ppu.dispcnt).toBe(0x0403)
  })

  it('rejects save states from a different ROM', () => {
    const gba = new Gba()
    gba.loadRom(RENDER_ROM)
    const state = gba.saveState()
    const other = new Gba()
    other.loadRom(makeRom([0xeafffffe]))
    expect(() => other.loadState(state)).toThrow(/different ROM/)
  })
})

describe('GBA PPU', () => {
  it('renders a 4bpp text background tile', () => {
    const gba = new Gba()
    gba.loadRom(makeRom([0xeafffffe]))
    // Palette: backdrop white, BG palette index 15 red.
    gba.bus.write16(0x05000000, 0x7fff)
    gba.bus.write16(0x0500001e, 0x001f)
    // Tile 0 row 0: pixels 15,15,15,15... (0xFFFF 4bpp row of 8 pixels)
    for (let i = 0; i < 8; i++) gba.bus.write8(0x06000000 + i, 0xff)
    // BG0 map block 1 at 0x06000800: entry 0 -> tile 0, entry 1 -> blank tile 1
    gba.bus.write16(0x06000800, 0x0000)
    gba.bus.write16(0x06000802, 0x0001)
    gba.ppu.bgcnt[0] = 0x0100 // 4bpp, screen base block 1, priority 0
    gba.ppu.dispcnt = 0x0100 // mode 0, BG0 enabled

    gba.ppu.renderScanline(0)
    expect(gba.getFrameBuffer()[0]).toBe(0xfff80000)
    expect(gba.getFrameBuffer()[8]).toBe(0xfff8f8f8)
  })

  it('renders affine sprites', () => {
    const gba = new Gba()
    gba.loadRom(makeRom([0xeafffffe]))
    // OBJ palette index 1 red.
    gba.bus.write16(0x05000202, 0x001f)
    // Sprite tile 0: 8x8 4bpp, first row all color 1.
    for (let i = 0; i < 4; i++) gba.bus.write8(0x06010000 + i, 0x11)
    // OAM entry 0: y=0, x=0, affine enabled, 8x8, tile 0.
    gba.bus.write16(0x07000000, 0x0100)
    gba.bus.write16(0x07000002, 0x0000)
    gba.bus.write16(0x07000004, 0x0000)
    // Identity affine matrix (PA=PD=1.0 in 8.8 fixed point).
    gba.bus.write16(0x07000006, 0x0100)
    gba.bus.write16(0x0700000c, 0x0100)
    gba.ppu.dispcnt = 0x1000 // OBJ enabled

    gba.ppu.renderScanline(0)
    expect(gba.getFrameBuffer()[0]).toBe(0xfff80000)
  })
})

describe('GBA boot flow', () => {
  it('branches from ARM to Thumb code and runs it', () => {
    const rom = new Uint8Array(0x1000)
    const view = new DataView(rom.buffer)
    view.setUint32(0x00, 0xe59f0004, true) // ldr r0,[pc,#4] -> 0x0c
    view.setUint32(0x04, 0xe12fff10, true) // bx r0
    view.setUint32(0x08, 0xeafffffe, true) // b .
    view.setUint32(0x0c, 0x08000011, true) // Thumb entry | 1
    view.setUint16(0x10, 0x2255, true) // movs r2,#0x55
    view.setUint16(0x12, 0x4901, true) // ldr r1,[pc,#4] -> 0x18
    view.setUint16(0x14, 0x600a, true) // str r2,[r1]
    view.setUint16(0x16, 0xe7fe, true) // b .
    view.setUint32(0x18, 0x03000000, true)

    const gba = new Gba()
    gba.loadRom(rom)
    for (let i = 0; i < 8; i++) gba.cpu.step()
    expect(gba.cpu.thumb).toBe(true)
    expect(gba.bus.read8(0x03000000)).toBe(0x55)
  })
})

describe('GBA interrupt delivery (HLE BIOS)', () => {
  it('runs the user IRQ handler on VBlank and returns to the interrupted code', () => {
    const code: number[] = []
    const lits: { index: number; value: number }[] = []
    const ldr = (rd: number, value: number) => {
      lits.push({ index: code.length, value })
      code.push(0xe59f0000 | (rd << 12))
    }
    const str = (rd: number, rn: number) => code.push(0xe5800000 | (rn << 16) | (rd << 12))
    const strh = (rd: number, rn: number) => code.push(0xe1c000b0 | (rn << 16) | (rd << 12))

    // Install the handler in the BIOS IRQ vector slot.
    ldr(0, 0x03007ffc)
    ldr(1, 0x08000080)
    str(1, 0)
    // Enable the VBlank IRQ in DISPSTAT, in IE, and turn on IME.
    ldr(0, 0x04000004)
    ldr(1, 8)
    strh(1, 0)
    ldr(0, 0x04000200)
    ldr(1, 1)
    strh(1, 0)
    ldr(0, 0x04000208)
    strh(1, 0)
    // Spin.
    code.push(0xeafffffe)

    // Handler at 0x08000080 writes a marker and acknowledges VBlank.
    while (code.length < 0x80 / 4) code.push(0xe1a00000) // mov r0,r0 (NOP)
    ldr(0, 0x03000000)
    ldr(1, 0xbeef)
    str(1, 0)
    ldr(0, 0x04000202)
    ldr(1, 1)
    strh(1, 0)
    code.push(0xe12fff1e) // bx lr

    const literalsStart = code.length * 4
    const rom = new Uint8Array(0x1000)
    const view = new DataView(rom.buffer)
    code.forEach((word, i) => view.setUint32(i * 4, word, true))
    lits.forEach((lit, n) => {
      const address = literalsStart + n * 4
      const instrAddress = lit.index * 4
      const offset = address - (instrAddress + 8)
      view.setUint32(lit.index * 4, 0xe59f0000 | (((code[lit.index] >>> 12) & 0xf) << 12) | offset, true)
      view.setUint32(address, lit.value, true)
    })

    const gba = new Gba()
    gba.loadRom(rom)
    gba.runFrame()

    expect(gba.bus.read32(0x03000000)).toBe(0xbeef)
    expect(gba.cpu.r[15]).toBeLessThan(0x08000080)
    expect(gba.irq.if_ & 1).toBe(0) // handler acknowledged VBlank
  })
})
