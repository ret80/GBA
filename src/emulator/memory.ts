
export class Memory {
  private gb: any;
  
  private bios: Uint8Array = new Uint8Array(0x100);
  private vram: Uint8Array = new Uint8Array(0x2000);
  private wram: Uint8Array = new Uint8Array(0x2000);
  private wramBanks: Uint8Array[] = Array.from({ length: 8 }, () => new Uint8Array(0x1000));
  private wramBankIndex: number = 1;
  private oam: Uint8Array = new Uint8Array(0xA0);
  private io: Uint8Array = new Uint8Array(0x80);
  private hram: Uint8Array = new Uint8Array(0x7F);

  public inBios: boolean = true;
  public dmaActive: boolean = false;
  public dmaSource: number = 0;
  public key1: number = 0; // CGB CPU speed (0xFF4D): bit7=pending, bit0=double speed

  public hdma1: number = 0xFF;
  public hdma2: number = 0xFF;
  public hdma3: number = 0xFF;
  public hdma4: number = 0xFF;
  public hdma5: number = 0xFF;
  public hdmaActive: boolean = false;
  public hdmaHblank: boolean = false;
  public hdmaSourceAddr: number = 0;
  public hdmaDestAddr: number = 0;
  public hdmaBytesLeft: number = 0;

  constructor(gb: any) {
    this.gb = gb;
    this.initBios();
  }

  getState(): Uint8Array {
    const state = new Uint8Array(
      1 + 4 + 1 + 0x2000 + 0x2000 + 8 * 0x1000 + 0xA0 + 0x80 + 0x7F + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 4 + 4 + 4
    );
    const view = new DataView(state.buffer);
    let off = 0;
    view.setUint8(off, this.inBios ? 1 : 0); off += 1;
    view.setUint32(off, this.dmaSource, true); off += 4;
    view.setUint8(off, this.key1); off += 1;
    state.set(this.wram, off); off += 0x2000;
    state.set(this.wramBanks[0], off); off += 0x1000;
    state.set(this.wramBanks[1], off); off += 0x1000;
    state.set(this.wramBanks[2], off); off += 0x1000;
    state.set(this.wramBanks[3], off); off += 0x1000;
    state.set(this.wramBanks[4], off); off += 0x1000;
    state.set(this.wramBanks[5], off); off += 0x1000;
    state.set(this.wramBanks[6], off); off += 0x1000;
    state.set(this.wramBanks[7], off); off += 0x1000;
    state.set(this.oam, off); off += 0xA0;
    state.set(this.io, off); off += 0x80;
    state.set(this.hram, off); off += 0x7F;
    view.setUint8(off, this.wramBankIndex); off += 1;
    view.setUint8(off, this.dmaActive ? 1 : 0); off += 1;
    view.setUint8(off, this.hdma1); off += 1;
    view.setUint8(off, this.hdma2); off += 1;
    view.setUint8(off, this.hdma3); off += 1;
    view.setUint8(off, this.hdma4); off += 1;
    view.setUint8(off, this.hdma5); off += 1;
    view.setUint8(off, this.hdmaActive ? 1 : 0); off += 1;
    view.setUint8(off, this.hdmaHblank ? 1 : 0); off += 1;
    view.setUint32(off, this.hdmaSourceAddr, true); off += 4;
    view.setUint32(off, this.hdmaDestAddr, true); off += 4;
    view.setUint32(off, this.hdmaBytesLeft, true); off += 4;
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 1 + 4 + 1 + 0x2000 + 0x2000 + 8 * 0x1000 + 0xA0 + 0x80 + 0x7F + 1) {
      throw new Error("Invalid Memory state");
    }
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    let off = 0;
    this.inBios = view.getUint8(off) === 1; off += 1;
    this.dmaSource = view.getUint32(off, true); off += 4;
    this.key1 = view.getUint8(off); off += 1;
    this.wram.set(state.subarray(off, off + 0x2000)); off += 0x2000;
    for (let b = 0; b < 8; b++) {
      this.wramBanks[b].set(state.subarray(off, off + 0x1000)); off += 0x1000;
    }
    this.oam.set(state.subarray(off, off + 0xA0)); off += 0xA0;
    this.io.set(state.subarray(off, off + 0x80)); off += 0x80;
    this.hram.set(state.subarray(off, off + 0x7F)); off += 0x7F;
    if (off < state.length) this.wramBankIndex = view.getUint8(off);
    if (off + 1 < state.length) this.dmaActive = view.getUint8(off + 1) === 1;
    if (off + 2 < state.length) this.hdma1 = view.getUint8(off + 2);
    if (off + 3 < state.length) this.hdma2 = view.getUint8(off + 3);
    if (off + 4 < state.length) this.hdma3 = view.getUint8(off + 4);
    if (off + 5 < state.length) this.hdma4 = view.getUint8(off + 5);
    if (off + 6 < state.length) this.hdma5 = view.getUint8(off + 6);
    if (off + 7 < state.length) this.hdmaActive = view.getUint8(off + 7) === 1;
    if (off + 8 < state.length) this.hdmaHblank = view.getUint8(off + 8) === 1;
    if (off + 9 < state.length) this.hdmaSourceAddr = view.getUint32(off + 9, true);
    if (off + 13 < state.length) this.hdmaDestAddr = view.getUint32(off + 13, true);
    if (off + 17 < state.length) this.hdmaBytesLeft = view.getUint32(off + 17, true);
  }

  private initBios(): void {
    this.inBios = false;
  }

  read8(addr: number): number {
    addr &= 0xFFFF;

    if (this.inBios && addr < 0x100) {
      return this.bios[addr];
    }

    if (addr >= 0x0000 && addr <= 0x3FFF) {
      if (this.gb.cartridge) {
        if ((this.gb.cartridge as any).readRom) return (this.gb.cartridge as any).readRom(addr);
      }
      return 0xFF;
    }

    if (addr >= 0x4000 && addr <= 0x7FFF) {
      if (this.gb.cartridge) {
        if ((this.gb.cartridge as any).readRom) return (this.gb.cartridge as any).readRom(addr);
      }
      return 0xFF;
    }

    if (addr >= 0x8000 && addr <= 0x9FFF) {
      const ppu: any = this.gb.ppu;
      if (ppu && Array.isArray(ppu.vram)) {
        const bank = ppu.VBK || 0;
        return ppu.vram[bank][addr - 0x8000];
      }
      return this.vram[addr - 0x8000];
    }

    if (addr >= 0xA000 && addr <= 0xBFFF) {
      if (this.gb.cartridge) {
        if ((this.gb.cartridge as any).readRam) return (this.gb.cartridge as any).readRam(addr - 0xA000);
      }
      return 0xFF;
    }

    if (addr >= 0xC000 && addr <= 0xCFFF) {
      return this.wram[addr - 0xC000];
    }

    if (addr >= 0xD000 && addr <= 0xDFFF) {
      const bank = this.wramBankIndex & 0x07;
      return this.wramBanks[bank][addr - 0xD000];
    }

    if (addr >= 0xE000 && addr <= 0xFDFF) {
      if (addr < 0xF000) return this.wram[addr - 0xE000];
      else return this.wramBanks[this.wramBankIndex & 0x07][addr - 0xF000];
    }

    if (addr >= 0xFE00 && addr <= 0xFE9F) {
      return this.oam[addr - 0xFE00];
    }

    if (addr >= 0xFEA0 && addr <= 0xFEFF) {
      return 0xFF;
    }

    if (addr >= 0xFF00 && addr <= 0xFF7F) {
      return this.readIO(addr);
    }

    if (addr >= 0xFF80 && addr <= 0xFFFE) {
      return this.hram[addr - 0xFF80];
    }

    if (addr === 0xFFFF) {
      return this.gb.interrupts ? this.gb.interrupts.IE : 0;
    }

    return 0xFF;
  }

  read16(addr: number): number {
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  write8(addr: number, value: number): void {
    value &= 0xFF;
    addr &= 0xFFFF;

    if (addr === 0xFF50 && value === 0x01) {
      this.inBios = false;
      return;
    }

    if (addr <= 0x7FFF) {
      if (this.gb.cartridge && (this.gb.cartridge as any).writeBank) {
        (this.gb.cartridge as any).writeBank(addr, value);
      }
      return;
    }

    if (addr >= 0x8000 && addr <= 0x9FFF) {
      const ppu: any = this.gb.ppu;
      if (ppu && Array.isArray(ppu.vram)) {
        const bank = ppu.VBK || 0;
        ppu.vram[bank][addr - 0x8000] = value;
      } else {
        this.vram[addr - 0x8000] = value;
      }
      return;
    }

    if (addr >= 0xA000 && addr <= 0xBFFF) {
      if (this.gb.cartridge && (this.gb.cartridge as any).writeRam) {
        (this.gb.cartridge as any).writeRam(addr - 0xA000, value);
      }
      return;
    }

    if (addr >= 0xC000 && addr <= 0xCFFF) {
      this.wram[addr - 0xC000] = value;
      return;
    }

    if (addr >= 0xD000 && addr <= 0xDFFF) {
      this.wramBanks[this.wramBankIndex & 0x07][addr - 0xD000] = value;
      return;
    }

    if (addr >= 0xE000 && addr <= 0xFDFF) {
      if (addr < 0xF000) this.wram[addr - 0xE000] = value;
      else this.wramBanks[this.wramBankIndex & 0x07][addr - 0xF000] = value;
      return;
    }

    if (addr >= 0xFE00 && addr <= 0xFE9F) {
      this.oam[addr - 0xFE00] = value;
      return;
    }

    if (addr >= 0xFEA0 && addr <= 0xFEFF) {
      return;
    }

    if (addr >= 0xFF00 && addr <= 0xFF7F) {
      this.writeIO(addr, value);
      return;
    }

    if (addr >= 0xFF80 && addr <= 0xFFFE) {
      this.hram[addr - 0xFF80] = value;
      return;
    }

    if (addr === 0xFFFF) {
      if (this.gb.interrupts) this.gb.interrupts.IE = value;
      return;
    }
  }

  private readIO(addr: number): number {
    if (addr === 0xFF00) return this.gb.joypad ? this.gb.joypad.read() : 0xCF;
    if (addr === 0xFF4C) return this.gb.cartridge && this.gb.cartridge.isCGB ? 0x11 : 0x00;
    if (addr === 0xFF4D) return (this.key1 & 0x80) | (this.gb.cpu && this.gb.cpu.doubleSpeed ? 0x01 : 0x00);
    if (addr === 0xFF04) return this.gb.timer ? this.gb.timer.DIV : 0;
    if (addr === 0xFF05) return this.gb.timer ? this.gb.timer.TIMA : 0;
    if (addr === 0xFF06) return this.gb.timer ? this.gb.timer.TMA : 0;
    if (addr === 0xFF07) return this.gb.timer ? this.gb.timer.TAC : 0;
    if (addr === 0xFF0F) return this.gb.interrupts ? this.gb.interrupts.IF : 0;
    if (addr === 0xFFFF) return this.gb.interrupts ? this.gb.interrupts.IE : 0;
    if (this.gb.apu) {
      const a: any = this.gb.apu;
      if (addr === 0xFF10) return a.NR10;
      if (addr === 0xFF11) return a.NR11;
      if (addr === 0xFF12) return a.NR12;
      if (addr === 0xFF13) return a.NR13;
      if (addr === 0xFF14) return a.NR14 | 0xBF;
      if (addr === 0xFF16) return a.NR21;
      if (addr === 0xFF17) return a.NR22;
      if (addr === 0xFF18) return a.NR23;
      if (addr === 0xFF19) return a.NR24 | 0xBF;
      if (addr === 0xFF1A) return a.NR30;
      if (addr === 0xFF1B) return a.NR31;
      if (addr === 0xFF1C) return a.NR32;
      if (addr === 0xFF1D) return a.NR33;
      if (addr === 0xFF1E) return a.NR34 | 0xBF;
      if (addr === 0xFF20) return a.NR41;
      if (addr === 0xFF21) return a.NR42;
      if (addr === 0xFF22) return a.NR43;
      if (addr === 0xFF23) return a.NR44 | 0xBF;
      if (addr === 0xFF24) return a.NR50;
      if (addr === 0xFF25) return a.NR51;
      if (addr === 0xFF26) return a.NR52;
      if (addr >= 0xFF30 && addr <= 0xFF3F) return a.waveRam[addr - 0xFF30];
    }
    if (this.gb.ppu) {
      const p: any = this.gb.ppu;
      if (addr === 0xFF40) return p.LCDC;
      if (addr === 0xFF41) return p.STAT | 0x80;
      if (addr === 0xFF42) return p.SCY;
      if (addr === 0xFF43) return p.SCX;
      if (addr === 0xFF44) return p.LY;
      if (addr === 0xFF45) return p.LYC;
      if (addr === 0xFF47) return p.BGP;
      if (addr === 0xFF48) return p.OBP0;
      if (addr === 0xFF49) return p.OBP1;
      if (addr === 0xFF4A) return p.WY;
      if (addr === 0xFF4B) return p.WX;
      if (addr === 0xFF4F) return p.VBK || 0;
      if (addr === 0xFF68) return p.BGPI || 0;
      if (addr === 0xFF69 && p.BGPD) return p.BGPD[p.BGPI & 0x3F];
      if (addr === 0xFF6A) return p.OBPI || 0;
      if (addr === 0xFF6B && p.OBPD) return p.OBPD[p.OBPI & 0x3F];
    }
    if (addr === 0xFF51) return this.hdma1;
    if (addr === 0xFF52) return this.hdma2;
    if (addr === 0xFF53) return this.hdma3;
    if (addr === 0xFF54) return this.hdma4;
    if (addr === 0xFF55) return this.hdma5;
    return this.io[addr - 0xFF00];
  }

  private writeIO(addr: number, value: number): void {
    if (addr === 0xFF00) { if (this.gb.joypad) { this.gb.joypad.write(value); } return; }
    if (addr === 0xFF04) { if (this.gb.timer) { this.gb.timer.DIV = 0; (this.gb.timer as any).divCounter = 0; } return; }
    if (addr >= 0xFF10 && addr <= 0xFF26) {
      const a: any = this.gb.apu;
      if (!a) return;
      // Centralize all sound-register handling (incl. triggers/envelopes) in
      // the APU so channel state and NR52 stay consistent.
      a.writeRegister(addr, value);
      return;
    }
    if (addr >= 0xFF30 && addr <= 0xFF3F) {
      if (this.gb.apu) (this.gb.apu as any).waveRam[addr - 0xFF30] = value;
      return;
    }
    if (addr === 0xFF4D) { this.key1 = (value & 0x01) ? 0x80 : 0x00; return; }
    if (addr === 0xFF05) { if (this.gb.timer) (this.gb.timer as any).TIMA = value; return; }
    if (addr === 0xFF06) { if (this.gb.timer) (this.gb.timer as any).TMA = value; return; }
    if (addr === 0xFF07) { if (this.gb.timer) (this.gb.timer as any).TAC = value; return; }
    if (this.gb.ppu) {
      const p: any = this.gb.ppu;
      if (addr === 0xFF40) { p.LCDC = value; return; }
      if (addr === 0xFF41) { p.STAT = (p.STAT & 0x07) | (value & 0x78); return; }
      if (addr === 0xFF42) { p.SCY = value; return; }
      if (addr === 0xFF43) { p.SCX = value; return; }
      if (addr === 0xFF44) { p.LY = 0; return; }
      if (addr === 0xFF45) { p.LYC = value; return; }
      if (addr === 0xFF47) { p.BGP = value; return; }
      if (addr === 0xFF48) { p.OBP0 = value; return; }
      if (addr === 0xFF49) { p.OBP1 = value; return; }
      if (addr === 0xFF4A) { p.WY = value; return; }
      if (addr === 0xFF4B) { p.WX = value; return; }
      if (addr === 0xFF4F) { p.VBK = value & 0x01; return; }
    if (addr === 0xFF70) {
        let b = value & 0x07;
        if (b === 0) b = 1;
        this.wramBankIndex = b;
        return;
      }
      if (addr === 0xFF68) { p.BGPI = value; return; }
      if (addr === 0xFF69) { if (p.BGPD) { p.BGPD[p.BGPI & 0x3F] = value; if (p.BGPI & 0x80) p.BGPI = (p.BGPI & 0xC0) | (((p.BGPI & 0x3F) + 1) & 0x3F); if (p.updatePalettes) p.updatePalettes(); } return; }
      if (addr === 0xFF6A) { p.OBPI = value; return; }
      if (addr === 0xFF6B) { if (p.OBPD) { p.OBPD[p.OBPI & 0x3F] = value; if (p.OBPI & 0x80) p.OBPI = (p.OBPI & 0xC0) | (((p.OBPI & 0x3F) + 1) & 0x3F); if (p.updatePalettes) p.updatePalettes(); } return; }
    }
    if (addr === 0xFF46) { this.startDma(value); return; }
    if (addr === 0xFF51) { this.hdma1 = value; return; }
    if (addr === 0xFF52) { this.hdma2 = value; return; }
    if (addr === 0xFF53) { this.hdma3 = value; return; }
    if (addr === 0xFF54) { this.hdma4 = value; return; }
    if (addr === 0xFF55) { this.hdma5 = value; this.startHdma(value); return; }
    if (addr === 0xFF0F) { if (this.gb.interrupts) (this.gb.interrupts as any).IF = value; return; }
    if (addr === 0xFFFF) { if (this.gb.interrupts) this.gb.interrupts.IE = value; return; }
    this.io[addr - 0xFF00] = value;
  }

  startHdma(value: number): void {
    const source = ((this.hdma1 << 8) | (this.hdma2 & 0xF0));
    const dest = ((this.hdma3 << 8) | (this.hdma4 & 0xF0)) | 0x8000;
    this.hdmaSourceAddr = source;
    this.hdmaDestAddr = dest;
    const length = (value & 0x7F) + 1;
    this.hdmaBytesLeft = length * 16;
    if (value & 0x80) {
      this.hdmaActive = true;
      this.hdmaHblank = true;
      this.hdma5 = value & 0x7F;
    } else {
      // General Purpose DMA (no bit 7): transfer the whole block immediately.
      this.hdmaActive = false;
      this.hdmaHblank = false;
      while (this.hdmaBytesLeft > 0) {
        this.doHdmaTransfer();
      }
      this.hdma5 = 0xFF;
    }
  }

  doHdmaTransfer(): void {
    for (let i = 0; i < 16 && this.hdmaBytesLeft > 0; i++) {
      const b = this.read8(this.hdmaSourceAddr++);
      const ppu: any = this.gb.ppu;
      if (ppu && Array.isArray(ppu.vram) && this.hdmaDestAddr >= 0x8000 && this.hdmaDestAddr < 0xA000) {
        const bank = ppu.VBK || 0;
        ppu.vram[bank][this.hdmaDestAddr - 0x8000] = b;
      }
      this.hdmaDestAddr++;
      this.hdmaBytesLeft--;
    }
    if (this.hdmaBytesLeft === 0) {
      this.hdmaActive = false;
      this.hdma5 = 0xFF;
    } else {
      this.hdma5 = Math.floor(this.hdmaBytesLeft / 16) - 1;
    }
  }

  stepHdma(): void {
    if (this.hdmaActive && this.hdmaHblank && this.hdmaBytesLeft > 0) {
      this.doHdmaTransfer();
    }
  }

  startDma(value: number): void {
    this.dmaSource = value << 8;
    this.dmaActive = true;
    for (let i = 0; i < 0xA0; i++) {
      this.oam[i] = this.read8(this.dmaSource + i);
    }
    this.dmaActive = false;
  }

  reset(): void {
    this.inBios = false;
    this.wram.fill(0);
    this.wramBanks.forEach((b) => b.fill(0));
    this.wramBankIndex = 1;
    this.vram.fill(0);
    this.oam.fill(0);
    this.hram.fill(0);
    this.io.fill(0);
    this.dmaActive = false;
    this.hdmaActive = false;
    this.key1 = 0;
  }
}
