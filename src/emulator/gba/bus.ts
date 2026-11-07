// GBA memory bus.
//
// The address space is decoded with 256-entry region tables (one table per
// access width), and the 1 KiB I/O page uses a 512-entry register table. Both
// are built once per bus instance, so accesses never walk a long chain of
// address comparisons in the common case.

import type { ArmBus } from "./arm7tdmi";

type RegionReader = (addr: number) => number;
type RegionWriter = (addr: number, value: number) => void;

export class GbaBus implements ArmBus {
  public ewram: Uint8Array = new Uint8Array(0x40000);
  public iwram: Uint8Array = new Uint8Array(0x8000);
  public io: Uint8Array = new Uint8Array(0x400);
  public palette: Uint8Array = new Uint8Array(0x400);
  public vram: Uint8Array = new Uint8Array(0x18000);
  public oam: Uint8Array = new Uint8Array(0x400);
  public rom: Uint8Array = new Uint8Array(0);

  private readonly read8Region: RegionReader[] = new Array(256);
  private readonly write8Region: RegionWriter[] = new Array(256);
  private readonly read16Region: RegionReader[] = new Array(256);
  private readonly write16Region: RegionWriter[] = new Array(256);

  private readonly ioRead: ((off: number) => number)[] = new Array(0x200);
  private readonly ioWrite: ((off: number, value: number) => void)[] = new Array(0x200);

  private readonly machine: any;

  constructor(machine: any) {
    this.machine = machine;
    this.initRegions();
    this.initIO();
  }

  get ppu(): any {
    return this.machine.ppu;
  }
  get dma(): any {
    return this.machine.dma;
  }
  get timers(): any {
    return this.machine.timers;
  }
  get irq(): any {
    return this.machine.irq;
  }
  get keypad(): any {
    return this.machine.keypad;
  }
  get cart(): any {
    return this.machine.cart;
  }

  // ---- Region decoding ----------------------------------------------------

  private initRegions(): void {
    const openBus: RegionReader = () => 0;
    const ignore: RegionWriter = () => {};

    // Default: unmapped regions read as zero and ignore writes.
    for (let i = 0; i < 256; i++) {
      this.read8Region[i] = openBus;
      this.write8Region[i] = ignore;
      this.read16Region[i] = openBus;
      this.write16Region[i] = ignore;
    }

    const ewramRead8: RegionReader = (a) => this.ewram[a & 0x3ffff];
    const iwramRead8: RegionReader = (a) => this.iwram[a & 0x7fff];
    const paletteRead8: RegionReader = (a) => this.palette[a & 0x3ff];
    const vramRead8: RegionReader = (a) => this.vram[a & 0x1ffff];
    const oamRead8: RegionReader = (a) => this.oam[a & 0x3ff];
    const romRead8: RegionReader = (a) => this.readRom8(a);
    const romRead16: RegionReader = (a) => this.readRom16(a);
    const saveRead8: RegionReader = (a) => this.cart.read8(a & 0xffff);
    const ioRead8: RegionReader = (a) => {
      const off = a & 0x3fe;
      const value = this.ioRead[off >> 1](off);
      return a & 1 ? (value >> 8) & 0xff : value & 0xff;
    };
    const ioRead16: RegionReader = (a) => this.ioRead[(a & 0x3fe) >> 1](a & 0x3fe);
    const ioWrite8: RegionWriter = (a, v) => this.writeIO8(a & 0x3ff, v);
    const ioWrite16: RegionWriter = (a, v) => this.ioWrite[(a & 0x3fe) >> 1](a & 0x3fe, v & 0xffff);

    this.read8Region[0x02] = ewramRead8;
    this.read8Region[0x03] = iwramRead8;
    this.read8Region[0x04] = ioRead8;
    this.read8Region[0x05] = paletteRead8;
    this.read8Region[0x06] = vramRead8;
    this.read8Region[0x07] = oamRead8;
    this.read8Region[0x0e] = saveRead8;
    this.read8Region[0x0f] = saveRead8;
    for (let region = 0x08; region <= 0x0d; region++) this.read8Region[region] = romRead8;

    this.read16Region[0x02] = (a) => this.ewramRead16(a);
    this.read16Region[0x03] = (a) => this.iwramRead16(a);
    this.read16Region[0x04] = ioRead16;
    this.read16Region[0x05] = (a) => this.paletteRead16(a);
    this.read16Region[0x06] = (a) => this.vramRead16(a);
    this.read16Region[0x07] = (a) => this.oamRead16(a);
    this.read16Region[0x0e] = (a) => this.cart.read8(a & 0xffff) * 0x0101;
    this.read16Region[0x0f] = (a) => this.cart.read8(a & 0xffff) * 0x0101;
    for (let region = 0x08; region <= 0x0d; region++) this.read16Region[region] = romRead16;

    this.write8Region[0x02] = (a, v) => (this.ewram[a & 0x3ffff] = v);
    this.write8Region[0x03] = (a, v) => (this.iwram[a & 0x7fff] = v);
    this.write8Region[0x04] = ioWrite8;
    this.write8Region[0x05] = (a, v) => (this.palette[a & 0x3ff] = v);
    this.write8Region[0x06] = (a, v) => (this.vram[a & 0x1ffff] = v);
    this.write8Region[0x07] = (a, v) => (this.oam[a & 0x3ff] = v);
    this.write8Region[0x0e] = (a, v) => this.cart.write8(a & 0xffff, v);
    this.write8Region[0x0f] = (a, v) => this.cart.write8(a & 0xffff, v);

    this.write16Region[0x02] = (a, v) => this.ewramWrite16(a, v);
    this.write16Region[0x03] = (a, v) => this.iwramWrite16(a, v);
    this.write16Region[0x04] = ioWrite16;
    this.write16Region[0x05] = (a, v) => {
      const off = a & 0x3fe;
      this.palette[off] = v & 0xff;
      this.palette[off + 1] = (v >> 8) & 0xff;
    };
    this.write16Region[0x06] = (a, v) => {
      const off = a & 0x1fffe;
      this.vram[off] = v & 0xff;
      this.vram[off + 1] = (v >> 8) & 0xff;
    };
    this.write16Region[0x07] = (a, v) => {
      const off = a & 0x3fe;
      this.oam[off] = v & 0xff;
      this.oam[off + 1] = (v >> 8) & 0xff;
    };
    this.write16Region[0x0e] = (a, v) => {
      this.cart.write8(a & 0xffff, v & 0xff);
      this.cart.write8((a + 1) & 0xffff, (v >> 8) & 0xff);
    };
    this.write16Region[0x0f] = this.write16Region[0x0e];
  }

  private readRom8(addr: number): number {
    const len = this.rom.length;
    if (len === 0) return 0xff;
    return this.rom[(addr & 0x01ffffff) % len];
  }

  private readRom16(addr: number): number {
    const a = addr & 0x01fffffe;
    return this.readRom8(a) | (this.readRom8(a + 1) << 8);
  }

  private ewramRead16(addr: number): number {
    const a = addr & 0x3fffe;
    return this.ewram[a] | (this.ewram[a + 1] << 8);
  }
  private ewramWrite16(addr: number, value: number): void {
    const a = addr & 0x3fffe;
    this.ewram[a] = value & 0xff;
    this.ewram[a + 1] = (value >> 8) & 0xff;
  }
  private iwramRead16(addr: number): number {
    const a = addr & 0x7ffe;
    return this.iwram[a] | (this.iwram[a + 1] << 8);
  }
  private iwramWrite16(addr: number, value: number): void {
    const a = addr & 0x7ffe;
    this.iwram[a] = value & 0xff;
    this.iwram[a + 1] = (value >> 8) & 0xff;
  }
  private paletteRead16(addr: number): number {
    const a = addr & 0x3fe;
    return this.palette[a] | (this.palette[a + 1] << 8);
  }
  private vramRead16(addr: number): number {
    const a = addr & 0x1fffe;
    return this.vram[a] | (this.vram[a + 1] << 8);
  }
  private oamRead16(addr: number): number {
    const a = addr & 0x3fe;
    return this.oam[a] | (this.oam[a + 1] << 8);
  }

  read8(addr: number): number {
    return this.read8Region[(addr >>> 24) & 0xff](addr >>> 0);
  }

  read16(addr: number): number {
    return this.read16Region[(addr >>> 24) & 0xff](addr >>> 0);
  }

  read32(addr: number): number {
    return (this.read16(addr) | (this.read16(addr + 2) << 16)) >>> 0;
  }

  write8(addr: number, value: number): void {
    this.write8Region[(addr >>> 24) & 0xff](addr >>> 0, value & 0xff);
  }

  write16(addr: number, value: number): void {
    this.write16Region[(addr >>> 24) & 0xff](addr >>> 0, value & 0xffff);
  }

  write32(addr: number, value: number): void {
    this.write16(addr, value & 0xffff);
    this.write16(addr + 2, (value >>> 16) & 0xffff);
  }

  // ---- I/O register page --------------------------------------------------

  /** Raw backing store for registers without dedicated handlers. */
  ioStoreRead(off: number): number {
    const o = off & 0x3fe;
    return this.io[o] | (this.io[o + 1] << 8);
  }

  ioStoreWrite(off: number, value: number): void {
    const o = off & 0x3fe;
    this.io[o] = value & 0xff;
    this.io[o + 1] = (value >> 8) & 0xff;
  }

  io16(off: number): number {
    return this.ioStoreRead(off);
  }

  writeIO16(off: number, value: number): void {
    this.ioStoreWrite(off, value);
  }

  private writeIO8(off: number, value: number): void {
    if (off === 0x301) {
      // HALTCNT: halt the CPU until the next interrupt.
      this.machine.cpu.halted = true;
      return;
    }
    if (off === 0x300) {
      this.io[0x300] = value & 0xff;
      return;
    }
    const aligned = off & 0x3fe;
    const current = this.ioRead[aligned >> 1](aligned);
    const next = off & 1 ? (current & 0x00ff) | ((value & 0xff) << 8) : (current & 0xff00) | (value & 0xff);
    this.ioWrite[aligned >> 1](aligned, next);
  }

  private initIO(): void {
    const defaultRead = (off: number) => this.ioStoreRead(off);
    const defaultWrite = (off: number, value: number) => this.ioStoreWrite(off, value);
    for (let i = 0; i < 0x200; i++) {
      this.ioRead[i] = defaultRead;
      this.ioWrite[i] = defaultWrite;
    }

    const map = (
      start: number,
      end: number,
      read: (off: number) => number,
      write: (off: number, value: number) => void
    ) => {
      for (let off = start; off <= end; off += 2) {
        this.ioRead[off >> 1] = read;
        this.ioWrite[off >> 1] = write;
      }
    };

    map(0x00, 0x56, (off) => this.ppu.readIO(off), (off, v) => this.ppu.writeIO(off, v));
    map(0xb0, 0xde, (off) => this.dma.readIO(off), (off, v) => this.dma.writeIO(off, v));
    map(
      0x100,
      0x10e,
      (off) => this.timers.readIO(off),
      (off, v) => this.timers.writeIO(off, v)
    );

    this.ioRead[0x130 >> 1] = () => this.keypad.readKeyInput();
    this.ioWrite[0x130 >> 1] = () => {};
    this.ioRead[0x132 >> 1] = () => this.keypad.keycnt;
    this.ioWrite[0x132 >> 1] = (_off, v) => (this.keypad.keycnt = v);

    this.ioRead[0x200 >> 1] = () => this.irq.ie;
    this.ioWrite[0x200 >> 1] = (_off, v) => (this.irq.ie = v & 0x3fff);
    this.ioRead[0x202 >> 1] = () => this.irq.if_;
    // REG_IF is write-1-to-clear: bits written as 1 acknowledge interrupts.
    this.ioWrite[0x202 >> 1] = (_off, v) => (this.irq.if_ = this.irq.if_ & ~v & 0x3fff);
    this.ioRead[0x208 >> 1] = () => this.irq.ime;
    this.ioWrite[0x208 >> 1] = (_off, v) => (this.irq.ime = v & 0x1);

    this.ioWrite[0x300 >> 1] = (off, v) => this.ioStoreWrite(off, v);
  }

  reset(): void {
    this.ewram.fill(0);
    this.iwram.fill(0);
    this.io.fill(0);
    this.palette.fill(0);
    this.vram.fill(0);
    this.oam.fill(0);
    this.cart.reset();
  }
}
