// High-level emulation of the GBA BIOS.
//
// Instead of running the real 16 KiB BIOS (which cannot be shipped with an
// emulator), the SWI vector is intercepted and common BIOS calls are
// implemented directly: decompression, math, memory copy/fill, affine setup
// and the interrupt/halt helpers. This is the standard HLE approach used by
// modern emulators when no BIOS image is supplied.

import {
  ARM_I,
  ARM_T,
  IRQ_RETURN_MARKER,
  MODE_IRQ,
  MODE_SVC,
  type Arm7tdmi,
} from "./arm7tdmi";

type SwiHandler = (bios: GbaBios, cpu: Arm7tdmi) => void;

export class GbaBios {
  private intrWaitFlags = 0;
  private savedCpsr = 0;
  private savedLr = 0;
  private savedSp = 0;
  private savedUserSp = 0;
  private savedUserLr = 0;
  private pendingAtEntry = 0;
  private resumeAfterIrq = false;

  private readonly machine: any;

  constructor(machine: any) {
    this.machine = machine;
  }

  get bus(): any {
    return this.machine.bus;
  }

  reset(): void {
    this.intrWaitFlags = 0;
    this.resumeAfterIrq = false;
    this.savedCpsr = 0;
    this.savedLr = 0;
    this.savedSp = 0;
    this.pendingAtEntry = 0;
  }

  get waitingForInterrupt(): number {
    return this.intrWaitFlags;
  }

  // ---- SWI entry point ----------------------------------------------------

  swi(cpu: Arm7tdmi, number: number): void {
    SWI_TABLE[number & 0xff](this, cpu);
  }

  private read8(a: number): number {
    return this.bus.read8(a);
  }
  private read16(a: number): number {
    return this.bus.read16(a);
  }
  private read32(a: number): number {
    return this.bus.read32(a);
  }
  private write8(a: number, v: number): void {
    this.bus.write8(a, v);
  }
  private write16(a: number, v: number): void {
    this.bus.write16(a, v);
  }
  private write32(a: number, v: number): void {
    this.bus.write32(a, v);
  }

  // ---- Interrupt delivery (HLE of the BIOS IRQ dispatcher) ----------------

  enterIrq(cpu: Arm7tdmi): void {
    const irq = this.machine.irq;
    this.savedCpsr = cpu.cpsr;
    this.savedLr = cpu.r[15];
    this.savedUserSp = cpu.r[13];
    this.savedUserLr = cpu.r[14];
    this.pendingAtEntry = irq.ie & irq.if_;

    if (this.intrWaitFlags && (this.pendingAtEntry & this.intrWaitFlags) !== 0) {
      this.resumeAfterIrq = true;
      this.intrWaitFlags = 0;
    }

    cpu.spsrRegs[MODE_IRQ] = cpu.cpsr;
    cpu.switchTo(MODE_SVC);
    cpu.cpsr = ((cpu.cpsr | ARM_I) & ~ARM_T) >>> 0;

    // The BIOS prologue saves r0-r3, r12 and lr on the supervisor stack.
    const registers = [cpu.r[0], cpu.r[1], cpu.r[2], cpu.r[3], cpu.r[12], cpu.r[14]];
    for (const value of registers) {
      cpu.r[13] = (cpu.r[13] - 4) >>> 0;
      this.write32(cpu.r[13], value);
    }
    this.savedSp = cpu.r[13];

    const handler = this.read32(0x03007ffc);
    if (handler === 0 || handler === 1) {
      this.leaveIrq(cpu);
      return;
    }
    cpu.r[14] = IRQ_RETURN_MARKER;
    cpu.r[15] = handler >>> 0;
  }

  leaveIrq(cpu: Arm7tdmi): void {
    const pending = this.pendingAtEntry;
    this.machine.irq.if_ &= ~pending;

    let sp = this.savedSp;
    const values: number[] = [];
    for (let i = 0; i < 6; i++) {
      values.push(this.read32(sp));
      sp = (sp + 4) >>> 0;
    }
    cpu.r[0] = values[0];
    cpu.r[1] = values[1];
    cpu.r[2] = values[2];
    cpu.r[3] = values[3];
    cpu.r[12] = values[4];
    cpu.r[14] = values[5];
    cpu.r[13] = sp;

    const mode = this.savedCpsr & 0x1f;
    cpu.switchTo(mode);
    cpu.cpsr = this.savedCpsr >>> 0;
    cpu.r[13] = this.savedUserSp;
    cpu.r[14] = this.savedUserLr;
    cpu.r[15] = this.savedLr >>> 0;

    if (this.resumeAfterIrq) {
      this.resumeAfterIrq = false;
      cpu.halted = false;
    }
  }

  // ---- Implemented BIOS calls --------------------------------------------

  softReset(cpu: Arm7tdmi): void {
    this.machine.softReset();
    cpu.bootState(this.machine.entryPoint);
    cpu.r[0] = 0;
    cpu.r[1] = 0;
  }

  registerRamReset(cpu: Arm7tdmi): void {
    const flags = cpu.r[0];
    const bus = this.bus;
    if (flags & 0x1) bus.ewram.fill(0);
    if (flags & 0x2) bus.iwram.fill(0);
    if (flags & 0x4) bus.palette.fill(0);
    if (flags & 0x8) bus.vram.fill(0);
    if (flags & 0x10) bus.oam.fill(0);
    cpu.r[0] = 0;
    cpu.r[1] = 0;
    cpu.r[3] = 0;
  }

  halt(cpu: Arm7tdmi): void {
    cpu.halted = true;
  }

  intrWait(cpu: Arm7tdmi): void {
    const flags = cpu.r[0] & 0x3fff;
    const discard = cpu.r[1] & 1;
    const pending = this.machine.irq.if_ & flags;
    if (pending !== 0) {
      if (discard) this.machine.irq.if_ &= ~pending;
      return;
    }
    this.intrWaitFlags = flags;
    if (discard) this.machine.irq.if_ &= ~flags;
    cpu.halted = true;
  }

  div(cpu: Arm7tdmi): void {
    this.divide(cpu, cpu.r[0] | 0, cpu.r[1] | 0);
  }

  divArm(cpu: Arm7tdmi): void {
    this.divide(cpu, cpu.r[1] | 0, cpu.r[0] | 0);
  }

  private divide(cpu: Arm7tdmi, numerator: number, denominator: number): void {
    if (denominator === 0) {
      cpu.r[0] = 0;
      cpu.r[1] = numerator >>> 0;
      cpu.r[3] = 0;
      return;
    }
    const quotient = (numerator / denominator) | 0;
    const remainder = (numerator % denominator) | 0;
    cpu.r[0] = quotient >>> 0;
    cpu.r[1] = remainder >>> 0;
    cpu.r[3] = Math.abs(quotient) >>> 0;
  }

  sqrt(cpu: Arm7tdmi): void {
    cpu.r[0] = Math.floor(Math.sqrt(cpu.r[0] >>> 0)) >>> 0;
  }

  arcTan(cpu: Arm7tdmi): void {
    const value = (cpu.r[0] << 16) >> 16;
    const angle = Math.atan(value / 16384) / Math.PI;
    cpu.r[0] = Math.round(angle * 0x8000) & 0xffff;
  }

  cpuSet(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    const dst = cpu.r[1];
    const control = cpu.r[2];
    const count = control & 0x1fffff;
    const word = (control & 0x01000000) !== 0;
    if (control & 0x04000000) {
      const value = word ? this.read32(src) : this.read16(src);
      for (let i = 0; i < count; i++) {
        if (word) this.write32(dst + i * 4, value);
        else this.write16(dst + i * 2, value);
      }
    } else {
      for (let i = 0; i < count; i++) {
        if (word) this.write32(dst + i * 4, this.read32(src + i * 4));
        else this.write16(dst + i * 2, this.read16(src + i * 2));
      }
    }
  }

  cpuFastSet(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    const dst = cpu.r[1];
    const control = cpu.r[2];
    const count = control & 0x1fffff;
    const fill = (control & 0x01000000) !== 0;
    const value = this.read32(src);
    for (let i = 0; i < count; i++) {
      this.write32(dst + i * 4, fill ? value : this.read32(src + i * 4));
    }
  }

  getBiosChecksum(cpu: Arm7tdmi): void {
    cpu.r[0] = 0xbaae187f;
  }

  bitUnpack(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    const dst = cpu.r[1];
    const info = cpu.r[2];
    const srcLen = this.read16(info);
    const srcWidth = this.read8(info + 2);
    const dstWidth = this.read8(info + 3);
    const offset = this.read32(info + 4);

    let srcBit = 0;
    let dstBit = 0;
    for (let i = 0; i < srcLen; i++) {
      let value = 0;
      for (let b = 0; b < srcWidth; b++) {
        const byte = this.read8(src + (srcBit >> 3));
        value = (value << 1) | ((byte >> (7 - (srcBit & 7))) & 1);
        srcBit++;
      }
      value = (value + offset) >>> 0;
      for (let b = dstWidth - 1; b >= 0; b--) {
        const addr = dst + (dstBit >> 3);
        let byte = this.read8(addr);
        const mask = 0x80 >> (dstBit & 7);
        byte = value & (1 << b) ? byte | mask : byte & ~mask;
        this.write8(addr, byte);
        dstBit++;
      }
    }
  }

  lz77(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    let dst = cpu.r[1];
    const header = this.read8(src);
    if ((header & 0xf0) !== 0x10) return;
    const size = this.read8(src + 1) | (this.read8(src + 2) << 8) | (this.read8(src + 3) << 16);
    let p = src + 4;
    let written = 0;
    while (written < size) {
      const flags = this.read8(p++);
      for (let bit = 7; bit >= 0 && written < size; bit--) {
        if (flags & (1 << bit)) {
          const b1 = this.read8(p++);
          const b2 = this.read8(p++);
          const length = (b1 >> 4) + 3;
          const displacement = (((b1 & 0x0f) << 8) | b2) + 1;
          for (let i = 0; i < length && written < size; i++) {
            this.write8(dst, this.read8(dst - displacement));
            dst++;
            written++;
          }
        } else {
          this.write8(dst++, this.read8(p++));
          written++;
        }
      }
    }
  }

  rlUncomp(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    let dst = cpu.r[1];
    const header = this.read8(src);
    if ((header & 0xf0) !== 0x30) return;
    const size = this.read8(src + 1) | (this.read8(src + 2) << 8) | (this.read8(src + 3) << 16);
    let p = src + 4;
    let written = 0;
    while (written < size) {
      const flags = this.read8(p++);
      for (let bit = 7; bit >= 0 && written < size; bit--) {
        if (flags & (1 << bit)) {
          let length = this.read8(p++);
          if (length & 0x80) length = ((length & 0x7f) << 8) | this.read8(p++);
          length += 3;
          const value = this.read8(p++);
          for (let i = 0; i < length && written < size; i++) {
            this.write8(dst++, value);
            written++;
          }
        } else {
          this.write8(dst++, this.read8(p++));
          written++;
        }
      }
    }
  }

  diff8(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    const dst = cpu.r[1];
    const size = this.read8(src) | (this.read8(src + 1) << 8) | (this.read8(src + 2) << 16);
    let previous = 0;
    for (let i = 0; i < size; i++) {
      previous = (previous + this.read8(src + 4 + i)) & 0xff;
      this.write8(dst + i, previous);
    }
  }

  diff16(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    const dst = cpu.r[1];
    const size = this.read8(src) | (this.read8(src + 1) << 8) | (this.read8(src + 2) << 16);
    let previous = 0;
    for (let i = 0; i < size; i += 2) {
      previous = (previous + this.read16(src + 4 + i)) & 0xffff;
      this.write16(dst + i, previous);
    }
  }

  bgAffineSet(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    let dst = cpu.r[1];
    const count = cpu.r[2];
    for (let i = 0; i < count; i++) {
      const base = src + i * 16;
      const pa = (this.read16(base) << 16) >> 16;
      const pb = (this.read16(base + 2) << 16) >> 16;
      const pc = (this.read16(base + 4) << 16) >> 16;
      const pd = (this.read16(base + 6) << 16) >> 16;
      const x = this.read32(base + 8) | 0;
      const y = this.read32(base + 12) | 0;

      this.write16(dst, pa);
      this.write16(dst + 2, pb);
      this.write16(dst + 4, pc);
      this.write16(dst + 6, pd);
      this.write32(dst + 8, (x - ((pa * x + pb * y) >> 8)) | 0);
      this.write32(dst + 12, (y - ((pc * x + pd * y) >> 8)) | 0);
      dst += 16;
    }
  }

  objAffineSet(cpu: Arm7tdmi): void {
    const src = cpu.r[0];
    let dst = cpu.r[1];
    const count = cpu.r[2];
    const stride = cpu.r[3] || 8;
    for (let i = 0; i < count; i++) {
      const base = src + i * 8;
      const sx = (this.read16(base) << 16) >> 16;
      const sy = (this.read16(base + 2) << 16) >> 16;
      const angle = this.read16(base + 4) & 0xffff;
      const radians = (angle / 0x10000) * Math.PI * 2;
      const cos = Math.round(Math.cos(radians) * 256);
      const sin = Math.round(Math.sin(radians) * 256);
      this.write16(dst, (sx * cos) >> 8);
      this.write16(dst + 2, (-sx * sin) >> 8);
      this.write16(dst + 4, (sy * sin) >> 8);
      this.write16(dst + 6, (sy * cos) >> 8);
      dst += stride;
    }
  }

  arcTan2(cpu: Arm7tdmi): void {
    const x = (cpu.r[0] << 16) >> 16;
    const y = (cpu.r[1] << 16) >> 16;
    const angle = Math.atan2(y, x) / (Math.PI * 2);
    cpu.r[0] = Math.round(angle * 0x10000) & 0xffff;
  }

  midiKey2Freq(cpu: Arm7tdmi): void {
    // r0 = wave data, r1 = midi key (fixed 8.8), r2 = frequency
    // Returns frequency = (waveFreq * 2^((key - 69)/12)).
    const key = cpu.r[1] / 256;
    const freq = cpu.r[2];
    cpu.r[0] = Math.round(freq * Math.pow(2, (key - 69) / 12)) >>> 0;
  }

  soundDriverInit(cpu: Arm7tdmi): void {
    cpu.r[0] = 0;
  }
}

const SWI_TABLE: SwiHandler[] = new Array(256).fill(() => {});

SWI_TABLE[0x00] = (b, c) => b.softReset(c);
SWI_TABLE[0x01] = (b, c) => b.registerRamReset(c);
SWI_TABLE[0x02] = (b, c) => b.halt(c);
SWI_TABLE[0x03] = (b, c) => b.halt(c);
SWI_TABLE[0x04] = (b, c) => b.intrWait(c);
SWI_TABLE[0x05] = (b, c) => {
  c.r[0] = 1;
  c.r[1] = 1;
  b.intrWait(c);
};
SWI_TABLE[0x06] = (b, c) => b.div(c);
SWI_TABLE[0x07] = (b, c) => b.divArm(c);
SWI_TABLE[0x08] = (b, c) => b.sqrt(c);
SWI_TABLE[0x09] = (b, c) => b.arcTan(c);
SWI_TABLE[0x0a] = (b, c) => b.arcTan2(c);
SWI_TABLE[0x0b] = (b, c) => b.cpuSet(c);
SWI_TABLE[0x0c] = (b, c) => b.cpuFastSet(c);
SWI_TABLE[0x0d] = (b, c) => b.getBiosChecksum(c);
SWI_TABLE[0x0e] = (b, c) => b.bgAffineSet(c);
SWI_TABLE[0x0f] = (b, c) => b.objAffineSet(c);
SWI_TABLE[0x10] = (b, c) => b.bitUnpack(c);
SWI_TABLE[0x11] = (b, c) => b.lz77(c);
SWI_TABLE[0x12] = (b, c) => b.lz77(c);
SWI_TABLE[0x14] = (b, c) => b.rlUncomp(c);
SWI_TABLE[0x15] = (b, c) => b.rlUncomp(c);
SWI_TABLE[0x16] = (b, c) => b.diff8(c);
SWI_TABLE[0x17] = (b, c) => b.diff8(c);
SWI_TABLE[0x18] = (b, c) => b.diff16(c);
SWI_TABLE[0x1a] = (b, c) => b.soundDriverInit(c);
SWI_TABLE[0x1e] = (b, c) => b.midiKey2Freq(c);
