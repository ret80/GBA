// Game Boy Advance machine: CPU + bus + PPU + DMA + timers + IRQs + HLE BIOS.

import { Arm7tdmi, type ArmBus, type ArmHooks } from "./arm7tdmi";
import { GbaBus } from "./bus";
import { GbaPpu, SCREEN_HEIGHT, SCREEN_WIDTH } from "./ppu";
import { GbaDma } from "./dma";
import { GbaTimers } from "./timers";
import { GbaIrq, IRQ_HBLANK } from "./irq";
import { GbaKeypad } from "./keypad";
import { GbaCartridge, type GbaSaveType } from "./cartridge";
import { GbaBios } from "./bios";
import { crc32, fromBase64, toBase64 } from "../utils";

const CYCLES_PER_FRAME = 280896; // 228 lines * 1232 cycles
const STATE_VERSION = 1;

const EMPTY_SAMPLES = new Float32Array(0);

function bytesToB64(bytes: Uint8Array): string {
  return toBase64(bytes);
}

function b64ToBytes(text: string): Uint8Array {
  return fromBase64(text);
}

export class Gba implements ArmHooks {
  public readonly bus: GbaBus;
  public readonly ppu: GbaPpu;
  public readonly dma: GbaDma;
  public readonly timers: GbaTimers;
  public readonly irq: GbaIrq;
  public readonly keypad: GbaKeypad;
  public readonly cart: GbaCartridge;
  public readonly bios: GbaBios;
  public readonly cpu: Arm7tdmi;

  /** Alias so the UI can treat both cores the same way. */
  public readonly joypad: GbaKeypad;
  public readonly apu: {
    sampleRate: number;
    readSamples(): Float32Array;
    reset(): void;
  };

  public readonly screenWidth = SCREEN_WIDTH;
  public readonly screenHeight = SCREEN_HEIGHT;
  public entryPoint = 0x08000000;

  private frameCycles = 0;

  constructor() {
    this.irq = new GbaIrq();
    this.cart = new GbaCartridge();
    this.keypad = new GbaKeypad(this);
    this.joypad = this.keypad;
    this.bus = new GbaBus(this);
    this.ppu = new GbaPpu(this);
    this.dma = new GbaDma(this);
    this.timers = new GbaTimers(this);
    this.bios = new GbaBios(this);
    this.apu = {
      sampleRate: 44100,
      readSamples: () => EMPTY_SAMPLES,
      reset: () => {},
    };
    this.cpu = new Arm7tdmi(this.bus as ArmBus, this);
  }

  // ---- ArmHooks -----------------------------------------------------------

  swi(cpu: Arm7tdmi, number: number): void {
    this.bios.swi(cpu, number);
  }

  haltWake(): boolean {
    return (this.irq.ie & this.irq.if_) !== 0;
  }

  irqPending(): boolean {
    return this.irq.pending;
  }

  enterIrq(cpu: Arm7tdmi): void {
    this.bios.enterIrq(cpu);
  }

  leaveIrq(cpu: Arm7tdmi): void {
    this.bios.leaveIrq(cpu);
  }

  // ---- Machine events -----------------------------------------------------

  requestIrq(bit: number): void {
    this.irq.request(bit);
  }

  onHblank(): void {
    this.ppu.dispstat |= 0x2;
    if (this.ppu.dispstat & 0x10) this.irq.request(IRQ_HBLANK);
    this.dma.onHBlank();
  }

  onVBlank(): void {
    this.dma.onVBlank();
  }

  softReset(): void {
    this.reset();
  }

  // ---- Public API ---------------------------------------------------------

  get saveType(): GbaSaveType {
    return this.cart.saveType;
  }

  loadRom(rom: Uint8Array): void {
    this.cart.load(rom);
    this.bus.rom = rom;
    this.reset();
  }

  reset(): void {
    this.irq.reset();
    this.bus.reset();
    this.ppu.reset();
    this.dma.reset();
    this.timers.reset();
    this.keypad.reset();
    this.bios.reset();
    this.cpu.bootState(this.entryPoint);
    this.frameCycles = 0;
  }

  runFrame(): void {
    while (this.frameCycles < CYCLES_PER_FRAME) {
      // A halted CPU does not need to be stepped cycle by cycle: advance the
      // rest of the machine in one scanline sized chunk until an interrupt
      // wakes it (modern emulators do the same with an event scheduler).
      if (this.cpu.halted && (this.irq.ie & this.irq.if_) === 0) {
        const chunk = 1232;
        this.frameCycles += chunk;
        this.timers.step(chunk);
        this.ppu.step(chunk);
        continue;
      }

      const cycles = this.cpu.step();
      const used = cycles > 0 ? cycles : 1;
      this.frameCycles += used;
      this.timers.step(used);
      this.ppu.step(used);
    }
    this.frameCycles -= CYCLES_PER_FRAME;
  }

  getFrameBuffer(): Uint32Array {
    return this.ppu.getFrameBuffer();
  }

  // ---- Save states --------------------------------------------------------

  saveState(): string {
    const state = {
      version: STATE_VERSION,
      romSize: this.cart.rom.length,
      romCrc32: crc32(this.cart.rom),
      cpu: Array.from(this.cpu.getState()),
      ppu: this.ppu.getState(),
      dma: this.dma.getState(),
      timers: this.timers.getState(),
      irq: [this.irq.ie, this.irq.if_, this.irq.ime],
      cart: this.cart.getState(),
      frameCycles: this.frameCycles,
      memory: {
        ewram: bytesToB64(this.bus.ewram),
        iwram: bytesToB64(this.bus.iwram),
        io: bytesToB64(this.bus.io),
        palette: bytesToB64(this.bus.palette),
        vram: bytesToB64(this.bus.vram),
        oam: bytesToB64(this.bus.oam),
        save: bytesToB64(this.cart.save),
      },
    };
    const json = JSON.stringify(state);
    return toBase64(new TextEncoder().encode(json));
  }

  loadState(encoded: string): void {
    const json = new TextDecoder().decode(fromBase64(encoded.trim()));
    const state = JSON.parse(json) as any;
    if (state.version !== STATE_VERSION) {
      throw new Error("Unsupported GBA save state version: " + state.version);
    }
    if (state.romSize !== this.cart.rom.length) {
      throw new Error(
        `Save state is for a different ROM: size ${state.romSize} bytes, expected ${this.cart.rom.length}`
      );
    }
    if (state.romCrc32 !== crc32(this.cart.rom)) {
      throw new Error("Save state is for a different ROM: checksum mismatch");
    }

    this.cpu.setState(new Uint32Array(state.cpu));
    this.ppu.setState(state.ppu);
    this.dma.setState(state.dma);
    this.timers.setState(state.timers);
    this.irq.ie = state.irq[0];
    this.irq.if_ = state.irq[1];
    this.irq.ime = state.irq[2];
    this.cart.setState(state.cart);
    this.frameCycles = state.frameCycles;

    const memory = state.memory;
    this.bus.ewram.set(b64ToBytes(memory.ewram));
    this.bus.iwram.set(b64ToBytes(memory.iwram));
    this.bus.io.set(b64ToBytes(memory.io));
    this.bus.palette.set(b64ToBytes(memory.palette));
    this.bus.vram.set(b64ToBytes(memory.vram));
    this.bus.oam.set(b64ToBytes(memory.oam));
    if (memory.save) this.cart.save.set(b64ToBytes(memory.save));
  }
}

/** True when the buffer looks like a GBA ROM (Nintendo logo marker at 0xB2). */
export function isGbaRom(rom: Uint8Array, fileName?: string): boolean {
  if (fileName && /\.gba$/i.test(fileName)) return true;
  if (rom.length < 0xc0) return false;
  // 0x96 is the fixed "complement check" byte in every GBA cartridge header.
  return rom[0xb2] === 0x96;
}
