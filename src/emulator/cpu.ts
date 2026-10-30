export class CPU {
  private gb: any;
  public A: number = 0x01;
  public F: number = 0xB0;
  public B: number = 0x00;
  public C: number = 0x13;
  public D: number = 0x00;
  public E: number = 0xD8;
  public H: number = 0x01;
  public L: number = 0x4D;
  public SP: number = 0xFFFE;
  public PC: number = 0x0100;
  public IME: boolean = false;
  public IMEEnabled: boolean = false;
  public halted: boolean = false;
  public stopped: boolean = false;
  public doubleSpeed: boolean = false;
  constructor(gb: any) { this.gb = gb; }
  get AF(): number { return ((this.A << 8) | (this.F & 0xF0)); }
  set AF(v: number) { this.A = (v >> 8) & 0xFF; this.F = v & 0xF0; }
  get BC(): number { return ((this.B << 8) | this.C); }
  set BC(v: number) { this.B = (v >> 8) & 0xFF; this.C = v & 0xFF; }
  get DE(): number { return ((this.D << 8) | this.E); }
  set DE(v: number) { this.D = (v >> 8) & 0xFF; this.E = v & 0xFF; }
  get HL(): number { return ((this.H << 8) | this.L); }
  set HL(v: number) { this.H = (v >> 8) & 0xFF; this.L = v & 0xFF; }
  get Z(): boolean { return (this.F & 0x80) !== 0; }
  set Z(v: boolean) { this.F = v ? (this.F | 0x80) : (this.F & 0x7F); }
  get N(): boolean { return (this.F & 0x40) !== 0; }
  set N(v: boolean) { this.F = v ? (this.F | 0x40) : (this.F & 0xBF); }
  get CY(): boolean { return (this.F & 0x10) !== 0; }
  set CY(v: boolean) { this.F = v ? (this.F | 0x10) : (this.F & 0xEF); }
  reset(): void {
    const cgb = this.gb && this.gb.cartridge && this.gb.cartridge.isCGB;
    if (cgb) {
      // CGB boot state: A=0x11 is used by CGB-only games to detect the platform
      this.A = 0x11; this.F = 0x80; this.B = 0x00; this.C = 0x00;
      this.D = 0x00; this.E = 0x08; this.H = 0x00; this.L = 0x80;
    } else {
      this.A = 0x01; this.F = 0xB0; this.B = 0x00; this.C = 0x13;
      this.D = 0x00; this.E = 0xD8; this.H = 0x01; this.L = 0x4D;
    }
    this.SP = 0xFFFE; this.PC = 0x0100;
    this.IME = false; this.IMEEnabled = false; this.halted = false; this.stopped = false;
    this.doubleSpeed = false;
  }

  getState(): Uint8Array {
    const state = new Uint8Array(14);
    const view = new DataView(state.buffer);
    view.setUint8(0, this.A);
    view.setUint8(1, this.F);
    view.setUint8(2, this.B);
    view.setUint8(3, this.C);
    view.setUint8(4, this.D);
    view.setUint8(5, this.E);
    view.setUint8(6, this.H);
    view.setUint8(7, this.L);
    view.setUint16(8, this.SP, true);
    view.setUint16(10, this.PC, true);
    const flags = (this.IME ? 1 : 0) | (this.IMEEnabled ? 2 : 0)
      | (this.halted ? 4 : 0) | (this.stopped ? 8 : 0)
      | (this.doubleSpeed ? 16 : 0);
    view.setUint8(12, flags);
    view.setUint8(13, 0);
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 14) throw new Error("Invalid CPU state");
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    this.A = view.getUint8(0);
    this.F = view.getUint8(1);
    this.B = view.getUint8(2);
    this.C = view.getUint8(3);
    this.D = view.getUint8(4);
    this.E = view.getUint8(5);
    this.H = view.getUint8(6);
    this.L = view.getUint8(7);
    this.SP = view.getUint16(8, true);
    this.PC = view.getUint16(10, true);
    const flags = view.getUint8(12);
    this.IME = (flags & 1) !== 0;
    this.IMEEnabled = (flags & 2) !== 0;
    this.halted = (flags & 4) !== 0;
    this.stopped = (flags & 8) !== 0;
    this.doubleSpeed = (flags & 16) !== 0;
  }

  private getPending(): number {
    return this.gb.interrupts ? this.gb.interrupts.IE & this.gb.interrupts.IF : 0;
  }
  read8(a: number): number { return this.gb.memory.read8(a & 0xFFFF); }
  write8(a: number, v: number): void { this.gb.memory.write8(a & 0xFFFF, v & 0xFF); }
  read16(a: number): number { return this.read8(a) | (this.read8(a + 1) << 8); }
  push16(v: number): void { this.SP = (this.SP - 1) & 0xFFFF; this.write8(this.SP, (v >> 8) & 0xFF); this.SP = (this.SP - 1) & 0xFFFF; this.write8(this.SP, v & 0xFF); }
  pop16(): number { const l = this.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; const h = this.read8(this.SP); this.SP = (this.SP + 1) & 0xFFFF; return (h << 8) | l; }
  step(): number {
    if (this.IMEEnabled) { this.IME = true; this.IMEEnabled = false; }
    if (this.halted && !this.getPending()) return 4;
    this.halted = false;
    if (this.IME) {
      const p = this.getPending();
      if (p) {
        this.IME = false; this.halted = false;
        if (p & 0x01) { this.gb.interrupts.IF &= ~0x01; this.push16(this.PC); this.PC = 0x0040; return 20; }
        if (p & 0x02) { this.gb.interrupts.IF &= ~0x02; this.push16(this.PC); this.PC = 0x0048; return 20; }
        if (p & 0x04) { this.gb.interrupts.IF &= ~0x04; this.push16(this.PC); this.PC = 0x0050; return 20; }
        if (p & 0x08) { this.gb.interrupts.IF &= ~0x08; this.push16(this.PC); this.PC = 0x0058; return 20; }
        if (p & 0x10) { this.gb.interrupts.IF &= ~0x10; this.push16(this.PC); this.PC = 0x0060; return 20; }
      }
    }
    const op = this.read8(this.PC++);
    if (op === 0xCB) {
      const cb = this.read8(this.PC++);
      return this.execCB(cb);
    }
    return this.exec(op);
  }
  execCB(op: number): number {
    let reg: number;
    const r = op & 0x07;
    switch (r) {
      case 0: reg = this.B; break;
      case 1: reg = this.C; break;
      case 2: reg = this.D; break;
      case 3: reg = this.E; break;
      case 4: reg = this.H; break;
      case 5: reg = this.L; break;
      case 6: reg = this.read8(this.HL); break;
      case 7: reg = this.A; break;
      default: reg = 0;
    }
    const op2 = (op >> 3) & 0x07;
    const bit = (op >> 3) & 0x07;
    if (op >= 0x40 && op < 0x80) {
      // BIT
      this.Z = ((reg >> bit) & 1) === 0;
      this.N = false;
      this.F |= 0x20;
      if (r === 6) return 16;
      return 8;
    } else if (op >= 0x80 && op < 0xC0) {
      reg = reg & ~(1 << bit);
    } else if (op >= 0xC0) {
      reg = reg | (1 << bit);
    } else {
      switch (op2) {
        case 0: { const c=(reg>>7)&1; reg=((reg<<1)|c)&0xFF; this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = c===1; break; }
        case 1: { const c=reg&1; reg=((reg>>1)|(c<<7))&0xFF; this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = c===1; break; }
        case 2: { const c=this.CY?1:0; const nc=(reg>>7)&1; reg=((reg<<1)|c)&0xFF; this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = nc===1; break; }
        case 3: { const c=this.CY?1:0; const nc=reg&1; reg=((reg>>1)|(c<<7))&0xFF; this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = nc===1; break; }
        case 4: { const c=(reg>>7)&1; reg=(reg<<1)&0xFF; this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = c===1; break; }
        case 5: { const c=reg&1; reg=((reg>>1)|(reg&0x80))&0xFF; this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = c===1; break; }
        case 6: { reg=((reg&0xF)<<4)|((reg>>4)&0xF); this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = false; break; }
        case 7: { const c=reg&1; reg=(reg>>1)&0xFF; this.Z=reg===0; this.N=false; this.F&=0xDF; this.CY = c===1; break; }
      }
    }
    switch (r) {
      case 0: this.B = reg & 0xFF; break;
      case 1: this.C = reg & 0xFF; break;
      case 2: this.D = reg & 0xFF; break;
      case 3: this.E = reg & 0xFF; break;
      case 4: this.H = reg & 0xFF; break;
      case 5: this.L = reg & 0xFF; break;
      case 6: this.write8(this.HL, reg & 0xFF); break;
      case 7: this.A = reg & 0xFF; break;
    }
    if (r === 6) return op < 0x40 ? 16 : 12;
    return op < 0x40 ? 8 : 8;
  }
  exec(op: number): number {
    switch (op) {
      case 0x00: return 4;
      case 0x01: this.C = this.read8(this.PC++); this.B = this.read8(this.PC++); return 12;
      case 0x02: this.write8(this.BC, this.A); return 8;
      case 0x03: this.BC = (this.BC + 1) & 0xFFFF; return 8;
      case 0x04: { const r = (this.B + 1) & 0xFF; this.Z = r === 0; this.N = false; if((this.B & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.B = r; return 4; }
      case 0x05: { const r = (this.B - 1) & 0xFF; this.Z = r === 0; this.N = true; if((this.B & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.B = r; return 4; }
      case 0x06: this.B = this.read8(this.PC++); return 8;
      case 0x07: { const c = (this.A >> 7) & 1; this.A = ((this.A << 1) | c) & 0xFF; this.Z = false; this.N = false; this.F &= 0xDF; this.CY = c === 1; return 4; }
      case 0x08: { const a8 = this.read16(this.PC); this.PC += 2; this.write8(a8, this.SP & 0xFF); this.write8(a8 + 1, (this.SP >> 8) & 0xFF); return 20; }
      case 0x09: this.addHL(this.BC); return 8;
      case 0x0A: this.A = this.read8(this.BC); return 8;
      case 0x0B: this.BC = (this.BC - 1) & 0xFFFF; return 8;
      case 0x0C: { const r = (this.C + 1) & 0xFF; this.Z = r === 0; this.N = false; if((this.C & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.C = r; return 4; }
      case 0x0D: { const r = (this.C - 1) & 0xFF; this.Z = r === 0; this.N = true; if((this.C & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.C = r; return 4; }
      case 0x0E: this.C = this.read8(this.PC++); return 8;
      case 0x0F: { const c = this.A & 1; this.A = ((this.A >> 1) | (c << 7)) & 0xFF; this.Z = false; this.N = false; this.F &= 0xDF; this.CY = c === 1; return 4; }
      case 0x11: this.E = this.read8(this.PC++); this.D = this.read8(this.PC++); return 12;
      case 0x12: this.write8(this.DE, this.A); return 8;
      case 0x13: this.DE = (this.DE + 1) & 0xFFFF; return 8;
      case 0x14: { const r = (this.D + 1) & 0xFF; this.Z = r === 0; this.N = false; if((this.D & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.D = r; return 4; }
      case 0x15: { const r = (this.D - 1) & 0xFF; this.Z = r === 0; this.N = true; if((this.D & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.D = r; return 4; }
      case 0x16: this.D = this.read8(this.PC++); return 8;
      case 0x17: { const c = this.CY ? 1 : 0; const nc = (this.A >> 7) & 1; this.A = ((this.A << 1) | c) & 0xFF; this.Z = false; this.N = false; this.F &= 0xDF; this.CY = nc === 1; return 4; }
      case 0x18: { const rr = (this.read8(this.PC++) << 24) >> 24; this.PC = (this.PC + rr) & 0xFFFF; return 12; }
      case 0x19: this.addHL(this.DE); return 8;
      case 0x1A: this.A = this.read8(this.DE); return 8;
      case 0x1B: this.DE = (this.DE - 1) & 0xFFFF; return 8;

      case 0x1C: { const r = (this.E + 1) & 0xFF; this.Z = r === 0; this.N = false; if((this.E & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.E = r; return 4; }
      case 0x1D: { const r = (this.E - 1) & 0xFF; this.Z = r === 0; this.N = true; if((this.E & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.E = r; return 4; }
      case 0x1E: this.E = this.read8(this.PC++); return 8; 
      case 0x1F: { const c = this.CY ? 1 : 0; const nc = this.A & 1; this.A = ((this.A >> 1) | (c << 7)) & 0xFF; this.Z = false; this.N = false; this.F &= 0xDF; this.CY = nc === 1; return 4; }
      case 0x27: this.daa(); return 4;
      case 0x20: if (!this.Z) { const rr = (this.read8(this.PC++) << 24) >> 24; this.PC = (this.PC + rr) & 0xFFFF; return 12; } this.PC++; return 8;
      case 0x21: this.L = this.read8(this.PC++); this.H = this.read8(this.PC++); return 12;
      case 0x22: this.write8(this.HL, this.A); this.HL = (this.HL + 1) & 0xFFFF; return 8;
      case 0x23: this.HL = (this.HL + 1) & 0xFFFF; return 8;
      case 0x24: { const r = (this.H + 1) & 0xFF; this.Z = r === 0; this.N = false; if((this.H & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.H = r; return 4; }
      case 0x25: { const r = (this.H - 1) & 0xFF; this.Z = r === 0; this.N = true; if((this.H & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.H = r; return 4; }
      case 0x26: this.H = this.read8(this.PC++); return 8;
      case 0x28: if (this.Z) { const rr = (this.read8(this.PC++) << 24) >> 24; this.PC = (this.PC + rr) & 0xFFFF; return 12; } this.PC++; return 8;
      case 0x29: this.addHL(this.HL); return 8;
      case 0x2A: this.A = this.read8(this.HL); this.HL = (this.HL + 1) & 0xFFFF; return 8;
      case 0x2B: this.HL = (this.HL - 1) & 0xFFFF; return 8;
      case 0x2C: { const r = (this.L + 1) & 0xFF; this.Z = r === 0; this.N = false; if((this.L & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.L = r; return 4; }
      case 0x2D: { const r = (this.L - 1) & 0xFF; this.Z = r === 0; this.N = true; if((this.L & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.L = r; return 4; }
      case 0x2E: this.L = this.read8(this.PC++); return 8;
      case 0x2F: this.A = (~this.A) & 0xFF; this.N = true; this.F |= 0x20; return 4;
      case 0x30: if (!this.CY) { const rr = (this.read8(this.PC++) << 24) >> 24; this.PC = (this.PC + rr) & 0xFFFF; return 12; } this.PC++; return 8;
      case 0x31: this.SP = this.read16(this.PC); this.PC += 2; return 12;
      case 0x32: this.write8(this.HL, this.A); this.HL = (this.HL - 1) & 0xFFFF; return 8;
      case 0x33: this.SP = (this.SP + 1) & 0xFFFF; return 8;
      case 0x36: this.write8(this.HL, this.read8(this.PC++)); return 12;
      case 0x37: this.CY = true; this.N = false; this.F &= 0xDF; return 4;
      case 0x38: if (this.CY) { const rr = (this.read8(this.PC++) << 24) >> 24; this.PC = (this.PC + rr) & 0xFFFF; return 12; } this.PC++; return 8;
      case 0x3A: this.A = this.read8(this.HL); this.HL = (this.HL - 1) & 0xFFFF; return 8;
      case 0x3C: { const r = (this.A + 1) & 0xFF; this.Z = r === 0; this.N = false; if((this.A & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.A = r; return 4; }
      case 0x3D: { const r = (this.A - 1) & 0xFF; this.Z = r === 0; this.N = true; if((this.A & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.A = r; return 4; }
      case 0x3E: this.A = this.read8(this.PC++); return 8;
      case 0x34: { const a = this.HL; let val = this.read8(a); let r = (val + 1) & 0xFF; this.Z = r === 0; this.N = false; if((val & 0xF) === 0xF) this.F |= 0x20; else this.F &= 0xDF; this.write8(a, r); return 12; }
      case 0x35: { const a = this.HL; let val = this.read8(a); let r = (val - 1) & 0xFF; this.Z = r === 0; this.N = true; if((val & 0xF) === 0) this.F |= 0x20; else this.F &= 0xDF; this.write8(a, r); return 12; }
      case 0x39: this.addHL(this.SP); return 8;
      case 0x3B: this.SP = (this.SP - 1) & 0xFFFF; return 8;
      case 0x3F: this.CY = !this.CY; this.N = false; this.F &= 0xDF; return 4;
      case 0x40: this.B = this.B; return 4; case 0x41: this.B = this.C; return 4; case 0x42: this.B = this.D; return 4; case 0x43: this.B = this.E; return 4; case 0x44: this.B = this.H; return 4; case 0x45: this.B = this.L; return 4; case 0x46: this.B = this.read8(this.HL); return 8; case 0x47: this.B = this.A; return 4;
      case 0x48: this.C = this.B; return 4; case 0x49: this.C = this.C; return 4; case 0x4A: this.C = this.D; return 4; case 0x4B: this.C = this.E; return 4; case 0x4C: this.C = this.H; return 4; case 0x4D: this.C = this.L; return 4; case 0x4E: this.C = this.read8(this.HL); return 8; case 0x4F: this.C = this.A; return 4;
      case 0x50: this.D = this.B; return 4; case 0x51: this.D = this.C; return 4; case 0x52: this.D = this.D; return 4; case 0x53: this.D = this.E; return 4; case 0x54: this.D = this.H; return 4; case 0x55: this.D = this.L; return 4; case 0x56: this.D = this.read8(this.HL); return 8; case 0x57: this.D = this.A; return 4;
      case 0x58: this.E = this.B; return 4; case 0x59: this.E = this.C; return 4; case 0x5A: this.E = this.D; return 4; case 0x5B: this.E = this.E; return 4; case 0x5C: this.E = this.H; return 4; case 0x5D: this.E = this.L; return 4; case 0x5E: this.E = this.read8(this.HL); return 8; case 0x5F: this.E = this.A; return 4;
      case 0x60: this.H = this.B; return 4; case 0x61: this.H = this.C; return 4; case 0x62: this.H = this.D; return 4; case 0x63: this.H = this.E; return 4; case 0x64: this.H = this.H; return 4; case 0x65: this.H = this.L; return 4; case 0x66: this.H = this.read8(this.HL); return 8; case 0x67: this.H = this.A; return 4;
      case 0x68: this.L = this.B; return 4; case 0x69: this.L = this.C; return 4; case 0x6A: this.L = this.D; return 4; case 0x6B: this.L = this.E; return 4; case 0x6C: this.L = this.H; return 4; case 0x6D: this.L = this.L; return 4; case 0x6E: this.L = this.read8(this.HL); return 8; case 0x6F: this.L = this.A; return 4;
      case 0x70: this.write8(this.HL, this.B); return 8; case 0x71: this.write8(this.HL, this.C); return 8; case 0x72: this.write8(this.HL, this.D); return 8; case 0x73: this.write8(this.HL, this.E); return 8; case 0x74: this.write8(this.HL, this.H); return 8; case 0x75: this.write8(this.HL, this.L); return 8; case 0x76: this.halted = true; return 4; case 0x77: this.write8(this.HL, this.A); return 8;
      case 0x10: {
        // STOP is a 2-byte instruction (0x10 0x00). `step()` already advanced
        // PC past the opcode, so only the padding byte is left to skip.
        if (this.gb.memory && (this.gb.memory as any).key1 & 0x80) {
          // CGB speed switch: writing KEY1 bit0=1 set bit7 (switch pending).
          // Executing STOP performs the switch. On real hardware bit7 stays
          // set after the switch completes, and games (e.g. Zelda: Oracle of
          // Seasons) poll KEY1 bit7 and wait for "1" before continuing.
          // Clearing it here makes that poll spin forever.
          (this.gb.memory as any).key1 = 0x80; // keep bit7 = 1 (switch done)
          this.doubleSpeed = !this.doubleSpeed;
          this.stopped = false;
          this.PC += 1;
          return 4;
        }
        this.stopped = true; this.PC++; return 4;
      }
      case 0x78: this.A = this.B; return 4; case 0x79: this.A = this.C; return 4; case 0x7A: this.A = this.D; return 4; case 0x7B: this.A = this.E; return 4; case 0x7C: this.A = this.H; return 4; case 0x7D: this.A = this.L; return 4; case 0x7E: this.A = this.read8(this.HL); return 8; case 0x7F: this.A = this.A; return 4;
      case 0x80: this.add(this.B); return 4; case 0x81: this.add(this.C); return 4; case 0x82: this.add(this.D); return 4; case 0x83: this.add(this.E); return 4; case 0x84: this.add(this.H); return 4; case 0x85: this.add(this.L); return 4; case 0x86: this.add(this.read8(this.HL)); return 8; case 0x87: this.add(this.A); return 4;
      case 0x88: this.adc(this.B); return 4; case 0x89: this.adc(this.C); return 4; case 0x8A: this.adc(this.D); return 4; case 0x8B: this.adc(this.E); return 4; case 0x8C: this.adc(this.H); return 4; case 0x8D: this.adc(this.L); return 4; case 0x8E: this.adc(this.read8(this.HL)); return 8; case 0x8F: this.adc(this.A); return 4;
      case 0x90: this.sub(this.B); return 4; case 0x91: this.sub(this.C); return 4; case 0x92: this.sub(this.D); return 4; case 0x93: this.sub(this.E); return 4; case 0x94: this.sub(this.H); return 4; case 0x95: this.sub(this.L); return 4; case 0x96: this.sub(this.read8(this.HL)); return 8; case 0x97: this.sub(this.A); return 4;
      case 0x98: this.sbc(this.B); return 4; case 0x99: this.sbc(this.C); return 4; case 0x9A: this.sbc(this.D); return 4; case 0x9B: this.sbc(this.E); return 4; case 0x9C: this.sbc(this.H); return 4; case 0x9D: this.sbc(this.L); return 4; case 0x9E: this.sbc(this.read8(this.HL)); return 8; case 0x9F: this.sbc(this.A); return 4;
      case 0xA0: this.and(this.B); return 4; case 0xA1: this.and(this.C); return 4; case 0xA2: this.and(this.D); return 4; case 0xA3: this.and(this.E); return 4; case 0xA4: this.and(this.H); return 4; case 0xA5: this.and(this.L); return 4; case 0xA6: this.and(this.read8(this.HL)); return 8; case 0xA7: this.and(this.A); return 4;
      case 0xA8: this.xor(this.B); return 4; case 0xA9: this.xor(this.C); return 4; case 0xAA: this.xor(this.D); return 4; case 0xAB: this.xor(this.E); return 4; case 0xAC: this.xor(this.H); return 4; case 0xAD: this.xor(this.L); return 4; case 0xAE: this.xor(this.read8(this.HL)); return 8; case 0xAF: this.xor(this.A); return 4;
      case 0xB0: this.or(this.B); return 4; case 0xB1: this.or(this.C); return 4; case 0xB2: this.or(this.D); return 4; case 0xB3: this.or(this.E); return 4; case 0xB4: this.or(this.H); return 4; case 0xB5: this.or(this.L); return 4; case 0xB6: this.or(this.read8(this.HL)); return 8; case 0xB7: this.or(this.A); return 4;
      case 0xB8: this.cp(this.B); return 4; case 0xB9: this.cp(this.C); return 4; case 0xBA: this.cp(this.D); return 4; case 0xBB: this.cp(this.E); return 4; case 0xBC: this.cp(this.H); return 4; case 0xBD: this.cp(this.L); return 4; case 0xBE: this.cp(this.read8(this.HL)); return 8; case 0xBF: this.cp(this.A); return 4;
      case 0xC0: if (!this.Z) { this.PC = this.pop16(); return 20; } return 8;
      case 0xC1: { const v = this.pop16(); this.C = v & 0xFF; this.B = (v >> 8) & 0xFF; return 12; }
      case 0xC2: if (!this.Z) { this.PC = this.read16(this.PC); return 16; } this.PC += 2; return 12;
      case 0xC3: this.PC = this.read16(this.PC); return 16;
      case 0xC4: if (!this.Z) { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; } this.PC += 2; return 12;
      case 0xC5: this.push16(this.BC); return 16;
      case 0xC6: this.add(this.read8(this.PC++)); return 8;
      case 0xC7: this.push16(this.PC); this.PC = 0x0000; return 16;
      case 0xC8: if (this.Z) { this.PC = this.pop16(); return 20; } return 8;
      case 0xC9: this.PC = this.pop16(); return 16;
      case 0xCA: if (this.Z) { this.PC = this.read16(this.PC); return 16; } this.PC += 2; return 12;
      case 0xCC: if (this.Z) { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; } this.PC += 2; return 12;
      case 0xCD: { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; }
      case 0xCE: this.adc(this.read8(this.PC++)); return 8;
      case 0xCF: this.push16(this.PC); this.PC = 0x0008; return 16;
      case 0xD0: if (!this.CY) { this.PC = this.pop16(); return 20; } return 8;
      case 0xD1: { const v = this.pop16(); this.E = v & 0xFF; this.D = (v >> 8) & 0xFF; return 12; }
      case 0xD2: if (!this.CY) { this.PC = this.read16(this.PC); return 16; } this.PC += 2; return 12;
      case 0xD4: if (!this.CY) { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; } this.PC += 2; return 12;
      case 0xD5: this.push16(this.DE); return 16;
      case 0xD6: this.sub(this.read8(this.PC++)); return 8;
      case 0xD7: this.push16(this.PC); this.PC = 0x0010; return 16;
      case 0xD8: if (this.CY) { this.PC = this.pop16(); return 20; } return 8;
      case 0xD9: this.PC = this.pop16(); this.IME = true; return 16;
      case 0xDA: if (this.CY) { this.PC = this.read16(this.PC); return 16; } this.PC += 2; return 12;
      case 0xDC: if (this.CY) { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; } this.PC += 2; return 12;
      case 0xDE: this.sbc(this.read8(this.PC++)); return 8;
      case 0xDF: this.push16(this.PC); this.PC = 0x0018; return 16;
      case 0xE0: { const a = 0xFF00 + this.read8(this.PC++); this.write8(a, this.A); return 12; }
      case 0xE1: { const v = this.pop16(); this.L = v & 0xFF; this.H = (v >> 8) & 0xFF; return 12; }
      case 0xE2: this.write8(0xFF00 + this.C, this.A); return 8;
      case 0xE3: console.warn('Unimpl:', op.toString(16), '@', (this.PC-1).toString(16)); this.PC += 1; return 4;
      case 0xE4: if (!this.Z) { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; } this.PC += 2; return 12;
      case 0xE5: this.push16(this.HL); return 16;
      case 0xE6: this.and(this.read8(this.PC++)); return 8;
      case 0xE7: this.push16(this.PC); this.PC = 0x0020; return 16;
      case 0xE8: { const e8 = (this.read8(this.PC++) << 24) >> 24; const sp = this.SP; this.SP = (this.SP + e8) & 0xFFFF; this.Z = false; this.N = false; if(((sp & 0xF) + (e8 & 0xF)) > 0xF) this.F |= 0x20; else this.F &= 0xDF; if(((sp & 0xFF) + (e8 & 0xFF)) > 0xFF) this.F |= 0x10; else this.F &= 0xEF; return 16; }
      case 0xE9: this.PC = this.HL; return 4;
      case 0xEA: { const a = this.read16(this.PC); this.PC += 2; this.write8(a, this.A); return 16; }
      case 0xEE: this.xor(this.read8(this.PC++)); return 8;
      case 0xEF: this.push16(this.PC); this.PC = 0x0028; return 16;
      case 0xF0: { const a = 0xFF00 + this.read8(this.PC++); this.A = this.read8(a); return 12; }
      case 0xF1: { const v = this.pop16(); this.F = v & 0xF0; this.A = (v >> 8) & 0xFF; return 12; }
      case 0xF2: this.A = this.read8(0xFF00 + this.C); return 8;
      case 0xF3: this.IME = false; return 4;
      case 0xF4: if (!this.CY) { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; } this.PC += 2; return 12;
      case 0xF5: this.push16(this.AF); return 16;
      case 0xF6: this.or(this.read8(this.PC++)); return 8;
      case 0xF7: this.push16(this.PC); this.PC = 0x0030; return 16;
      case 0xF8: { const f8 = (this.read8(this.PC++) << 24) >> 24; this.HL = (this.SP + f8) & 0xFFFF; this.Z = false; this.N = false; if(((this.SP & 0xF) + (f8 & 0xF)) > 0xF) this.F |= 0x20; else this.F &= 0xDF; if(((this.SP & 0xFF) + (f8 & 0xFF)) > 0xFF) this.F |= 0x10; else this.F &= 0xEF; return 12; }
      case 0xF9: this.SP = this.HL; return 8;
      case 0xFA: { const a = this.read16(this.PC); this.PC += 2; this.A = this.read8(a); return 16; }
      case 0xFB: this.IMEEnabled = true; return 4;
      case 0xFC: if (this.Z) { const a = this.read16(this.PC); this.PC += 2; this.push16(this.PC); this.PC = a; return 24; } this.PC += 2; return 12;
      case 0xFD: this.PC += 1; return 4;
      case 0xFE: this.cp(this.read8(this.PC++)); return 8;
      case 0xFF: this.push16(this.PC); this.PC = 0x0038; return 16;
      default: console.warn('Unimpl:', op.toString(16), '@', (this.PC-1).toString(16)); return 4;
    }
  }
  addHL(v: number): void { const r = this.HL + v; this.N = false; if(((this.HL & 0xFFF) + (v & 0xFFF)) > 0xFFF) this.F |= 0x20; else this.F &= 0xDF; if(r > 0xFFFF) this.F |= 0x10; else this.F &= 0xEF; this.HL = r & 0xFFFF; }
  add(v: number): void { const r = this.A + v; if(((this.A & 0xF) + (v & 0xF)) > 0xF) this.F |= 0x20; else this.F &= 0xDF; if(r > 0xFF) this.F |= 0x10; else this.F &= 0xEF; this.A = r & 0xFF; this.Z = this.A === 0; this.N = false; }
  adc(v: number): void { const c = this.CY ? 1 : 0; const r = this.A + v + c; if(((this.A & 0xF) + (v & 0xF) + c) > 0xF) this.F |= 0x20; else this.F &= 0xDF; if(r > 0xFF) this.F |= 0x10; else this.F &= 0xEF; this.A = r & 0xFF; this.Z = this.A === 0; this.N = false; }
  sub(v: number): void { const r = this.A - v; if(((this.A & 0xF) < (v & 0xF))) this.F |= 0x20; else this.F &= 0xDF; if(r < 0) this.F |= 0x10; else this.F &= 0xEF; this.A = r & 0xFF; this.Z = this.A === 0; this.N = true; }
  sbc(v: number): void { const c = this.CY ? 1 : 0; const r = this.A - v - c; if(((this.A & 0xF) < ((v & 0xF) + c))) this.F |= 0x20; else this.F &= 0xDF; if(r < 0) this.F |= 0x10; else this.F &= 0xEF; this.A = r & 0xFF; this.Z = this.A === 0; this.N = true; }
  and(v: number): void { this.A = (this.A & v) & 0xFF; this.Z = this.A === 0; this.N = false; this.F |= 0x20; this.F &= 0xEF; }
  or(v: number): void { this.A = (this.A | v) & 0xFF; this.Z = this.A === 0; this.N = false; this.F &= 0xDF; this.F &= 0xEF; }
  xor(v: number): void { this.A = (this.A ^ v) & 0xFF; this.Z = this.A === 0; this.N = false; this.F &= 0xDF; this.F &= 0xEF; }
  cp(v: number): void { const r = this.A - v; this.Z = ((r & 0xFF) === 0); this.N = true; if(((this.A & 0xF) < (v & 0xF))) this.F |= 0x20; else this.F &= 0xDF; if(r < 0) this.F |= 0x10; else this.F &= 0xEF; }
  daa(): void {
    let a = this.A;
    if (!this.N) {
      if (this.CY || a > 0x99) { a += 0x60; this.CY = true; }
      if (this.F & 0x20 || (a & 0x0F) > 0x09) { a += 0x06; }
    } else {
      if (this.CY) { a -= 0x60; this.CY = true; }
      if (this.F & 0x20) { a -= 0x06; }
    }
    this.A = a & 0xFF;
    this.Z = this.A === 0;
    this.F &= 0xDF;
  }
}
