import { CPU } from "./cpu";
import { Memory } from "./memory";
import { PPU } from "./ppu";
import { APU } from "./apu";
import { Timer } from "./timer";
import { Interrupts } from "./interrupts";
import { Joypad } from "./joypad";
import { Cartridge } from "./cartridge";
import { toBase64, fromBase64, crc32 } from "./utils";

const STATE_VERSION = 2;

interface StateHeader {
  title: string;
  romSize: number;
  romCrc32: number;
}

function encodeHeader(header: StateHeader): Uint8Array {
  const encoder = new TextEncoder();
  const title = encoder.encode(header.title);
  // Layout: magic(7) + version(1) + reserved(1) + titleLen(1) + title +
  // romSize(4) + romCrc32(4) + partsCount(1)
  const head = new Uint8Array(9 + 1 + title.length + 4 + 4 + 1);
  head.set(encoder.encode("GBSTATE"), 0);
  head[7] = STATE_VERSION;
  head[8] = 0;
  head[9] = title.length;
  head.set(title, 10);
  let off = 10 + title.length;
  const view = new DataView(head.buffer);
  view.setUint32(off, header.romSize, true);
  view.setUint32(off + 4, header.romCrc32, true);
  head[off + 8] = 8; // number of parts
  return head;
}

function decodeHeader(state: Uint8Array): StateHeader & { off: number; partsCount: number } {
  if (state.length < 19) throw new Error("Invalid save state: truncated");
  if (state[0] !== 0x47 || state[1] !== 0x42 || state[2] !== 0x53 ||
      state[3] !== 0x54 || state[4] !== 0x41 || state[5] !== 0x54 || state[6] !== 0x45) {
    throw new Error("Invalid save state: bad signature");
  }
  const version = state[7];
  if (version !== 1 && version !== 2) {
    throw new Error("Unsupported save state version: " + version);
  }
  const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
  if (version === 1) {
    // Legacy layout: magic(7)+version(1)+reserved(1), then 8x uint32 length prefixes.
    return { title: "", romSize: 0, romCrc32: 0, off: 9, partsCount: 8 };
  }
  const titleLen = state[9];
  if (state.length < 10 + titleLen + 9) throw new Error("Invalid save state: truncated");
  let off = 10;
  const decoder = new TextDecoder();
  const title = decoder.decode(state.subarray(off, off + titleLen));
  off += titleLen;
  const romSize = view.getUint32(off, true);
  const romCrc32 = view.getUint32(off + 4, true);
  off += 8;
  const partsCount = state[off];
  if (partsCount !== 8) throw new Error("Invalid save state: bad part count");
  return { title, romSize, romCrc32, off: off + 1, partsCount };
}

export class GameBoy {
  public cpu: CPU;
  public memory: Memory;
  public ppu: PPU;
  public apu: APU;
  public timer: Timer;
  public interrupts: Interrupts;
  public joypad: Joypad;
  public cartridge: Cartridge;

  private cyclesPerFrame: number = 70224; // ~4.194 MHz / 59.7 Hz

  constructor() {
    this.interrupts = new Interrupts(this);
    this.timer = new Timer(this);
    this.joypad = new Joypad(this);
    this.cartridge = new Cartridge();
    this.memory = new Memory(this);
    this.ppu = new PPU(this);
    this.apu = new APU(this);
    this.cpu = new CPU(this);
  }

  loadRom(rom: Uint8Array): void {
    this.cartridge.load(rom);
    this.reset();
  }

  reset(): void {
    if(typeof this.cpu.reset === "function") this.cpu.reset();
    this.memory.reset();
    this.ppu.reset();
    this.apu.reset();
    this.timer.reset();
    this.interrupts.reset();
    this.joypad.reset();
    this.cartridge.reset();
  }

  runFrame(): void {
    let cycles = 0;
    while (cycles < this.cyclesPerFrame) {
      const cpuCycles = this.cpu.step();
      // Double speed: CPU ticks at 8.388 MHz, so a CPU instruction advances
      // the PPU/APU/Timer clock by half as many 4.194 MHz cycles.
      const eff = this.cpu.doubleSpeed ? cpuCycles / 2 : cpuCycles;
      cycles += eff;

      this.timer.step(eff);
      this.ppu.step(eff);
      if (this.memory && (this.memory as any).stepHdma) {
        // Check if in HBlank
        if (this.ppu.mode === 0 && this.ppu.LY < 144) {
          (this.memory as any).stepHdma();
        }
      }
      this.apu.step(eff);
    }
  }

  getFrameBuffer(): Uint32Array {
    return this.ppu.getFrameBuffer();
  }

  saveState(): string {
    const rom = this.cartridge.rom;
    const title = this.cartridge.title;
    const romCrc32 = crc32(rom);

    const cpu = this.cpu.getState();
    const mem = this.memory.getState();
    const ppu = this.ppu.getState();
    const apu = this.apu.getState();
    const timer = this.timer.getState();
    const interrupts = this.interrupts.getState();
    const joypad = this.joypad.getState();
    const cartridge = this.cartridge.getState();

    const parts = [cpu, mem, ppu, apu, timer, interrupts, joypad, cartridge];
    const head = encodeHeader({ title, romSize: rom.length, romCrc32 });
    const total = head.length + parts.length * 4 + parts.reduce((sum, p) => sum + p.length, 0);
    const state = new Uint8Array(total);
    const view = new DataView(state.buffer);
    state.set(head, 0);

    let off = head.length;
    for (const part of parts) {
      view.setUint32(off, part.length, true);
      off += 4;
      state.set(part, off);
      off += part.length;
    }

    return toBase64(state);
  }

  loadState(encoded: string): void {
    const state = fromBase64(encoded);
    const headerInfo = decodeHeader(state);

    // Validate against currently loaded ROM before mutating anything.
    const rom = this.cartridge.rom;
    const currentTitle = this.cartridge.title;
    if (headerInfo.romSize > 0) {
      if (headerInfo.romSize !== rom.length) {
        const expectedTitle = headerInfo.title || String(currentTitle || "(unknown)");
        throw new Error(
          `Save state is for a different ROM: size ${headerInfo.romSize} bytes, expected ${rom.length} (${expectedTitle})`
        );
      }
      if (headerInfo.romCrc32 !== crc32(rom)) {
        const expectedTitle = headerInfo.title || String(currentTitle || "(unknown)");
        throw new Error(
          `Save state is for a different ROM: checksum mismatch (${expectedTitle})`
        );
      }
    }

    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    let off = headerInfo.off;
    const parts: Uint8Array[] = [];
    for (let i = 0; i < headerInfo.partsCount; i++) {
      if (off + 4 > state.length) throw new Error("Invalid save state: truncated");
      const len = view.getUint32(off, true);
      off += 4;
      if (off + len > state.length) throw new Error("Invalid save state: truncated");
      parts.push(state.subarray(off, off + len));
      off += len;
    }
    if (off !== state.length) throw new Error("Invalid save state: trailing data");

    this.cpu.setState(parts[0]);
    this.memory.setState(parts[1]);
    this.ppu.setState(parts[2]);
    this.apu.setState(parts[3]);
    this.timer.setState(parts[4]);
    this.interrupts.setState(parts[5]);
    this.joypad.setState(parts[6]);
    this.cartridge.setState(parts[7]);
  }
}
