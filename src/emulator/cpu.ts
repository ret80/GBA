import { MAIN_OPS, CB_OPS } from "./sm83/optable";

/**
 * SM83 (Game Boy / Game Boy Color) CPU.
 *
 * The interpreter is table-driven: every opcode is decoded once at module load
 * into a handler entry (`{ execute, cycles, mnemonic }`) stored in a lookup
 * table. `step()` therefore costs one indexed load + one call instead of
 * walking a 256-case switch, and the tables can be shared by every machine
 * instance. The 0xCB-prefixed page gets its own table, so no nested switch is
 * needed either.
 *
 * Flags live in the classic F register (kept for save-state compatibility) and
 * are computed with the precomputed tables in `sm83/flags.ts`.
 */
export class CPU {
  public readonly gb: any;

  public A: number = 0x01;
  public F: number = 0xb0;
  public B: number = 0x00;
  public C: number = 0x13;
  public D: number = 0x00;
  public E: number = 0xd8;
  public H: number = 0x01;
  public L: number = 0x4d;
  public SP: number = 0xfffe;
  public PC: number = 0x0100;
  public IME: boolean = false;
  public IMEEnabled: boolean = false;
  public halted: boolean = false;
  public stopped: boolean = false;
  public doubleSpeed: boolean = false;

  constructor(gb: any) {
    this.gb = gb;
  }

  get AF(): number {
    return (this.A << 8) | (this.F & 0xf0);
  }
  set AF(v: number) {
    this.A = (v >> 8) & 0xff;
    this.F = v & 0xf0;
  }
  get BC(): number {
    return (this.B << 8) | this.C;
  }
  set BC(v: number) {
    this.B = (v >> 8) & 0xff;
    this.C = v & 0xff;
  }
  get DE(): number {
    return (this.D << 8) | this.E;
  }
  set DE(v: number) {
    this.D = (v >> 8) & 0xff;
    this.E = v & 0xff;
  }
  get HL(): number {
    return (this.H << 8) | this.L;
  }
  set HL(v: number) {
    this.H = (v >> 8) & 0xff;
    this.L = v & 0xff;
  }
  get Z(): boolean {
    return (this.F & 0x80) !== 0;
  }
  set Z(v: boolean) {
    this.F = v ? this.F | 0x80 : this.F & 0x7f;
  }
  get N(): boolean {
    return (this.F & 0x40) !== 0;
  }
  set N(v: boolean) {
    this.F = v ? this.F | 0x40 : this.F & 0xbf;
  }
  get CY(): boolean {
    return (this.F & 0x10) !== 0;
  }
  set CY(v: boolean) {
    this.F = v ? this.F | 0x10 : this.F & 0xef;
  }

  reset(): void {
    const cgb = this.gb && this.gb.cartridge && this.gb.cartridge.isCGB;
    if (cgb) {
      // CGB boot state: A=0x11 is used by CGB-only games to detect the platform
      this.A = 0x11;
      this.F = 0x80;
      this.B = 0x00;
      this.C = 0x00;
      this.D = 0x00;
      this.E = 0x08;
      this.H = 0x00;
      this.L = 0x80;
    } else {
      this.A = 0x01;
      this.F = 0xb0;
      this.B = 0x00;
      this.C = 0x13;
      this.D = 0x00;
      this.E = 0xd8;
      this.H = 0x01;
      this.L = 0x4d;
    }
    this.SP = 0xfffe;
    this.PC = 0x0100;
    this.IME = false;
    this.IMEEnabled = false;
    this.halted = false;
    this.stopped = false;
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
    const flags =
      (this.IME ? 1 : 0) |
      (this.IMEEnabled ? 2 : 0) |
      (this.halted ? 4 : 0) |
      (this.stopped ? 8 : 0) |
      (this.doubleSpeed ? 16 : 0);
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

  // ---- Bus access ---------------------------------------------------------

  read8(a: number): number {
    return this.gb.memory.read8(a & 0xffff);
  }
  write8(a: number, v: number): void {
    this.gb.memory.write8(a & 0xffff, v & 0xff);
  }
  read16(a: number): number {
    return this.read8(a) | (this.read8(a + 1) << 8);
  }
  push16(v: number): void {
    this.SP = (this.SP - 1) & 0xffff;
    this.write8(this.SP, (v >> 8) & 0xff);
    this.SP = (this.SP - 1) & 0xffff;
    this.write8(this.SP, v & 0xff);
  }
  pop16(): number {
    const l = this.read8(this.SP);
    this.SP = (this.SP + 1) & 0xffff;
    const h = this.read8(this.SP);
    this.SP = (this.SP + 1) & 0xffff;
    return (h << 8) | l;
  }

  // ---- Interrupts ---------------------------------------------------------

  private getPending(): number {
    return this.gb.interrupts ? this.gb.interrupts.IE & this.gb.interrupts.IF : 0;
  }

  /** Highest priority pending interrupt, or 0. Index 0 = VBlank. */
  private static readonly IRQ_VECTORS = [0x40, 0x48, 0x50, 0x58, 0x60];

  private serviceInterrupt(instance: number): number {
    const irq = this.gb.interrupts;
    irq.IF &= ~(1 << instance);
    this.push16(this.PC);
    this.PC = CPU.IRQ_VECTORS[instance];
    this.IME = false;
    this.halted = false;
    return 20;
  }

  // ---- Execution ----------------------------------------------------------

  step(): number {
    // EI takes effect only after the instruction that follows it.
    if (this.IMEEnabled) {
      this.IME = true;
      this.IMEEnabled = false;
    }

    if (this.halted) {
      if (!this.getPending()) return 4;
      this.halted = false;
    }

    if (this.IME) {
      const pending = this.getPending();
      if (pending) {
        let bit = 0;
        while ((pending & (1 << bit)) === 0) bit++;
        return this.serviceInterrupt(bit);
      }
    }

    const opcode = this.read8(this.PC++);
    return opcode === 0xcb
      ? CB_OPS[this.read8(this.PC++)].execute(this)
      : MAIN_OPS[opcode].execute(this);
  }

  exec(op: number): number {
    if (op === 0xcb) return CB_OPS[this.read8(this.PC++)].execute(this);
    return MAIN_OPS[op].execute(this);
  }

  /** Compatibility wrapper for the 0xCB page. */
  execCB(op: number): number {
    return CB_OPS[op].execute(this);
  }
}
