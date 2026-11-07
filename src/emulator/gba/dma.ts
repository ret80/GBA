import { IRQ_DMA0 } from "./irq";

const DMA_BASE = 0xb0;

interface DmaChannel {
  sad: number;
  dad: number;
  count: number;
  control: number;
}

/**
 * GBA DMA controller. Transfers are performed synchronously (immediate mode
 * when the channel is enabled, or on VBlank/HBlank for timed channels). This
 * is the usual interpreter approximation: the CPU does not observe the bus
 * being busy, but register state, IRQs and repeat behaviour match.
 */
export class GbaDma {
  public channels: DmaChannel[] = Array.from({ length: 4 }, () => ({
    sad: 0,
    dad: 0,
    count: 0,
    control: 0,
  }));

  private readonly machine: any;

  constructor(machine: any) {
    this.machine = machine;
  }

  get bus(): any {
    return this.machine.bus;
  }

  reset(): void {
    for (const ch of this.channels) {
      ch.sad = 0;
      ch.dad = 0;
      ch.count = 0;
      ch.control = 0;
    }
  }

  readIO(off: number): number {
    const channel = Math.floor((off - DMA_BASE) / 12);
    const reg = (off - DMA_BASE) % 12;
    const ch = this.channels[channel];
    if (reg === 0) return ch.sad & 0xffff;
    if (reg === 2) return (ch.sad >>> 16) & 0xffff;
    if (reg === 4) return ch.dad & 0xffff;
    if (reg === 6) return (ch.dad >>> 16) & 0xffff;
    if (reg === 8) return ch.count & 0xffff;
    return ch.control & 0xffff;
  }

  writeIO(off: number, value: number): void {
    const channel = Math.floor((off - DMA_BASE) / 12);
    const reg = (off - DMA_BASE) % 12;
    const ch = this.channels[channel];
    value &= 0xffff;
    if (reg === 0) ch.sad = (ch.sad & 0xffff0000) | value;
    else if (reg === 2) ch.sad = ((ch.sad & 0xffff) | (value << 16)) >>> 0;
    else if (reg === 4) ch.dad = (ch.dad & 0xffff0000) | value;
    else if (reg === 6) ch.dad = ((ch.dad & 0xffff) | (value << 16)) >>> 0;
    else if (reg === 8) ch.count = value;
    else {
      ch.control = value;
      if (value & 0x8000) this.start(channel);
    }
  }

  /** Start a channel; timed channels wait for their trigger. */
  private start(index: number): void {
    const ch = this.channels[index];
    const timing = (ch.control >> 12) & 0x3;
    if (timing === 0) this.transfer(index);
    // VBlank (1) / HBlank (2) channels run from the PPU callbacks. Timing 3
    // (special, sound/DMA0) is approximated by immediate transfer.
    if (timing === 3) this.transfer(index);
  }

  onVBlank(): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.channels[i];
      if (ch.control & 0x8000 && ((ch.control >> 12) & 0x3) === 1) this.transfer(i);
    }
  }

  onHBlank(): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.channels[i];
      if (ch.control & 0x8000 && ((ch.control >> 12) & 0x3) === 2) this.transfer(i);
    }
  }

  private transfer(index: number): void {
    const ch = this.channels[index];
    if (!(ch.control & 0x8000)) return;

    let count = ch.count === 0 ? (index === 3 ? 0x10000 : 0x4000) : ch.count;
    const word = (ch.control & 0x400) !== 0;
    const unit = word ? 4 : 2;
    const destControl = (ch.control >> 5) & 0x3;
    const srcControl = (ch.control >> 7) & 0x3;

    let src = ch.sad;
    let dst = ch.dad;
    const bus = this.bus;

    for (let i = 0; i < count; i++) {
      if (word) bus.write32(dst & ~3, bus.read32(src & ~3));
      else bus.write16(dst & ~1, bus.read16(src & ~1));
      if (srcControl === 0) src += unit;
      else if (srcControl === 1) src -= unit;
      if (destControl === 0) dst += unit;
      else if (destControl === 1) dst -= unit;
    }

    const repeat = (ch.control & 0x200) !== 0;
    if (!repeat) {
      ch.sad = src >>> 0;
      ch.dad = dst >>> 0;
    }

    if (ch.control & 0x4000) {
      // IRQ on completion.
      this.machine.requestIrq(IRQ_DMA0 + index);
    }

    if (!repeat) ch.control &= ~0x8000;
  }

  getState(): number[] {
    const out: number[] = [];
    for (const ch of this.channels) out.push(ch.sad, ch.dad, ch.count, ch.control);
    return out;
  }

  setState(state: number[]): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.channels[i];
      ch.sad = state[i * 4] ?? 0;
      ch.dad = state[i * 4 + 1] ?? 0;
      ch.count = state[i * 4 + 2] ?? 0;
      ch.control = state[i * 4 + 3] ?? 0;
    }
  }
}
