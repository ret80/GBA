export class Cartridge {
  public rom: Uint8Array = new Uint8Array(0);
  public ram: Uint8Array = new Uint8Array(0x8000);
  
  public title: string = "";
  public cartridgeType: number = 0;
  public romSize: number = 0;
  public ramSize: number = 0;
  public isCGB: boolean = false;
  public mbcType: number = 0;

  // MBC state
  public romBank: number = 1;
  public ramBank: number = 0;
  public ramEnabled: boolean = false;
  public bankingMode: number = 0; // 0 = ROM banking mode, 1 = RAM banking mode
  public rtcRegister: number = 0;

  constructor() {}

  load(rom: Uint8Array): void {
    this.rom = rom;
    this.parseHeader();
    this.initRam();
    this.resetMbc();
  }

  private parseHeader(): void {
    // Title at 0x0134-0x0143
    let title = "";
    for (let i = 0x134; i < 0x144; i++) {
      if (this.rom[i] >= 0x20 && this.rom[i] <= 0x7E) {
        title += String.fromCharCode(this.rom[i]);
      }
    }
    this.title = title;

    // CGB flag at 0x0143
    this.isCGB = this.rom[0x143] === 0x80 || this.rom[0x143] === 0xC0 || this.rom[0x143] === 0xC0;

    this.cartridgeType = this.rom[0x147];
    this.romSize = this.rom[0x148];
    this.ramSize = this.rom[0x149];
    this.mbcType = this.getMbcType(this.cartridgeType);
  }

  private getMbcType(type: number): number {
    if (type === 0x00) return 0; // ROM ONLY
    if (type >= 0x01 && type <= 0x03) return 1; // MBC1
    if (type >= 0x05 && type <= 0x06) return 2; // MBC2
    if (type >= 0x0F && type <= 0x13) return 3; // MBC3
    if (type >= 0x19 && type <= 0x1E) return 5; // MBC5
    return 0;
  }

  private initRam(): void {
    let ramSize = 0;
    switch (this.ramSize) {
      case 0x00: ramSize = 0; break;
      case 0x01: ramSize = 0x800; break; // 2KB
      case 0x02: ramSize = 0x2000; break; // 8KB
      case 0x03: ramSize = 0x8000; break; // 32KB
      case 0x04: ramSize = 0x20000; break; // 128KB
      case 0x05: ramSize = 0x10000; break; // 64KB
      default: ramSize = 0x8000;
    }
    this.ram = new Uint8Array(ramSize);
  }

  private resetMbc(): void {
    this.romBank = 1;
    this.ramBank = 0;
    this.ramEnabled = false;
    this.bankingMode = 0;
  }

  writeBank(addr: number, value: number): void {
    value &= 0xFF;
    if (this.mbcType === 0) return;

    if (this.mbcType === 1) {
      if (addr >= 0x0000 && addr <= 0x1FFF) {
        this.ramEnabled = (value & 0x0F) === 0x0A;
      } else if (addr >= 0x2000 && addr <= 0x3FFF) {
        let bank = value & 0x1F;
        if (bank === 0) bank = 1;
        this.romBank = (this.romBank & 0xE0) | bank;
      } else if (addr >= 0x4000 && addr <= 0x5FFF) {
        if (this.bankingMode === 0) {
          this.romBank = (this.romBank & 0x1F) | ((value & 0x03) << 5);
        } else {
          this.ramBank = value & 0x03;
        }
      } else if (addr >= 0x6000 && addr <= 0x7FFF) {
        this.bankingMode = value & 0x01;
      }
    } else if (this.mbcType === 3) {
      if (addr >= 0x0000 && addr <= 0x1FFF) {
        this.ramEnabled = (value & 0x0F) === 0x0A;
      } else if (addr >= 0x2000 && addr <= 0x3FFF) {
        let bank = value & 0x7F;
        if (bank === 0) bank = 1;
        this.romBank = bank;
      } else if (addr >= 0x4000 && addr <= 0x5FFF) {
        this.ramBank = value & 0x0F;
      } else if (addr >= 0x6000 && addr <= 0x7FFF) {
        // RTC latch - simplified
      }
    } else if (this.mbcType === 5) {
      if (addr >= 0x0000 && addr <= 0x1FFF) {
        this.ramEnabled = (value & 0x0F) === 0x0A;
      } else if (addr >= 0x2000 && addr <= 0x2FFF) {
        this.romBank = (this.romBank & 0x100) | value;
      } else if (addr >= 0x3000 && addr <= 0x3FFF) {
        this.romBank = (this.romBank & 0xFF) | ((value & 0x01) << 8);
      } else if (addr >= 0x4000 && addr <= 0x5FFF) {
        this.ramBank = value & 0x0F;
      }
    }
  }

  readRom(addr: number): number {
    if (this.mbcType === 0) {
      if (addr < this.rom.length) return this.rom[addr];
      return 0xFF;
    } else if (this.mbcType === 1) {
      if (addr >= 0x0000 && addr <= 0x3FFF) {
        if (this.bankingMode === 1 && (this.romBank & 0xE0)) {
          const bank = (this.romBank & 0xE0) >> 5;
          const realAddr = bank * 0x4000 + addr;
          if (realAddr < this.rom.length) return this.rom[realAddr];
        }
        if (addr < this.rom.length) return this.rom[addr];
        return 0xFF;
      } else if (addr >= 0x4000 && addr <= 0x7FFF) {
        const realAddr = this.romBank * 0x4000 + (addr - 0x4000);
        if (realAddr < this.rom.length) return this.rom[realAddr];
        return 0xFF;
      }
    } else if (this.mbcType === 3 || this.mbcType === 5) {
      if (addr >= 0x0000 && addr <= 0x3FFF) {
        if (addr < this.rom.length) return this.rom[addr];
        return 0xFF;
      } else if (addr >= 0x4000 && addr <= 0x7FFF) {
        const realAddr = this.romBank * 0x4000 + (addr - 0x4000);
        if (realAddr < this.rom.length) return this.rom[realAddr];
        return 0xFF;
      }
    }
    if (addr < this.rom.length) return this.rom[addr];
    return 0xFF;
  }

  readRam(addr: number): number {
    if (!this.ramEnabled || this.ram.length === 0) return 0xFF;
    if (this.mbcType === 1) {
      if (this.bankingMode === 0) this.ramBank = 0;
    }
    const realAddr = this.ramBank * 0x2000 + addr;
    if (realAddr < this.ram.length) return this.ram[realAddr];
    return 0xFF;
  }

  writeRam(addr: number, value: number): void {
    if (!this.ramEnabled || this.ram.length === 0) return;
    if (this.mbcType === 1) {
      if (this.bankingMode === 0) this.ramBank = 0;
    }
    const realAddr = this.ramBank * 0x2000 + addr;
    if (realAddr < this.ram.length) {
      this.ram[realAddr] = value & 0xFF;
    }
  }

  reset(): void {
    this.resetMbc();
  }

  getState(): Uint8Array {
    const state = new Uint8Array(9 + this.ram.length);
    const view = new DataView(state.buffer);
    view.setUint32(0, this.rom.length, true); // for sanity checks
    state.set(this.ram, 4);
    state.set([
      this.romBank & 0xFF,
      (this.romBank >> 8) & 0xFF,
      this.ramBank,
      this.ramEnabled ? 1 : 0,
      this.bankingMode,
    ], 4 + this.ram.length);
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 9) throw new Error("Invalid Cartridge state");
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    const romLen = view.getUint32(0, true);
    if (romLen !== this.rom.length) {
      throw new Error("Save state is for a different ROM");
    }
    if (state.length < 4 + this.ram.length + 5) {
      throw new Error("Invalid Cartridge state");
    }
    this.ram.set(state.subarray(4, 4 + this.ram.length));
    const off = 4 + this.ram.length;
    this.romBank = state[off] | (state[off + 1] << 8);
    this.ramBank = state[off + 2];
    this.ramEnabled = state[off + 3] === 1;
    this.bankingMode = state[off + 4] & 0xFF;
  }
}
