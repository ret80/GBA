// ARM7TDMI (ARMv4T) CPU core used by the Game Boy Advance.
//
// Design notes (modern interpreter techniques):
//  * ARM instructions are classified ONCE at module load into a 1024-entry
//    dispatch table (bits 27-20 plus bits 7 and 4). The hot loop is a table
//    lookup + call, not a per-instruction switch.
//  * Thumb instructions use a 256-entry table indexed by bits 15-8 and are
//    handled by format-specific emitters, matching the real Thumb encoding.
//  * Condition codes are evaluated through a 16-entry predicate table.
//  * Flags live in the CPSR word (N/Z/C/V/T/I/F/mode) so exceptions and
//    MSR/MRS behave like the hardware.
//
// Memory is reached through `ArmBus` (16-bit accesses, like the GBA bus) and
// the rest of the machine through `ArmHooks` (BIOS calls and IRQ delivery).

export const ARM_N = 0x80000000;
export const ARM_Z = 0x40000000;
export const ARM_C = 0x20000000;
export const ARM_V = 0x10000000;
export const ARM_T = 0x20;
export const ARM_F = 0x40;
export const ARM_I = 0x80;

export const MODE_USR = 0x10;
export const MODE_FIQ = 0x11;
export const MODE_IRQ = 0x12;
export const MODE_SVC = 0x13;
export const MODE_ABT = 0x17;
export const MODE_UND = 0x1b;
export const MODE_SYS = 0x1f;

export const SPRSR_MODES = [MODE_USR, MODE_FIQ, MODE_IRQ, MODE_SVC, MODE_ABT, MODE_UND, MODE_SYS];

/** Sentinel address the HLE BIOS IRQ handler returns through. */
export const IRQ_RETURN_MARKER = 0xfffffff0;

export interface ArmBus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, value: number): void;
  write16(addr: number, value: number): void;
  write32(addr: number, value: number): void;
}

export interface ArmHooks {
  /** Execute a BIOS software interrupt with the given SWI number. */
  swi(cpu: Arm7tdmi, number: number): void;
  /** True when an interrupt is being requested (IE & IF). */
  haltWake(): boolean;
  /** True when an IRQ should be taken (IME & IE & IF & !CPSR.I). */
  irqPending(): boolean;
  /** HLE BIOS IRQ prologue: acknowledge, switch to SVC, call user handler. */
  enterIrq(cpu: Arm7tdmi): void;
  /** Called when the HLE IRQ handler returns through the marker address. */
  leaveIrq(cpu: Arm7tdmi): void;
}

type ArmHandler = (cpu: Arm7tdmi, instr: number) => void;
type ThumbHandler = (cpu: Arm7tdmi, instr: number) => void;

const sign8 = (v: number): number => (v << 24) >> 24;
const sign11 = (v: number): number => (v << 21) >> 21;
const sign24 = (v: number): number => (v << 8) >> 8;

const CONDITION: ((c: Arm7tdmi) => boolean)[] = [
  (c) => (c.cpsr & ARM_Z) !== 0, // EQ
  (c) => (c.cpsr & ARM_Z) === 0, // NE
  (c) => (c.cpsr & ARM_C) !== 0, // CS
  (c) => (c.cpsr & ARM_C) === 0, // CC
  (c) => (c.cpsr & ARM_N) !== 0, // MI
  (c) => (c.cpsr & ARM_N) === 0, // PL
  (c) => (c.cpsr & ARM_V) !== 0, // VS
  (c) => (c.cpsr & ARM_V) === 0, // VC
  (c) => (c.cpsr & ARM_C) !== 0 && (c.cpsr & ARM_Z) === 0, // HI
  (c) => (c.cpsr & ARM_C) === 0 || (c.cpsr & ARM_Z) !== 0, // LS
  (c) => ((c.cpsr & ARM_N) !== 0) === ((c.cpsr & ARM_V) !== 0), // GE
  (c) => ((c.cpsr & ARM_N) !== 0) !== ((c.cpsr & ARM_V) !== 0), // LT
  (c) => (c.cpsr & ARM_Z) === 0 && ((c.cpsr & ARM_N) !== 0) === ((c.cpsr & ARM_V) !== 0), // GT
  (c) => (c.cpsr & ARM_Z) !== 0 || ((c.cpsr & ARM_N) !== 0) !== ((c.cpsr & ARM_V) !== 0), // LE
  () => true, // AL
  () => true, // NV (unconditional on ARMv4T)
];

export class Arm7tdmi {
  public r: Uint32Array = new Uint32Array(16);
  public cpsr: number = MODE_SYS | ARM_I | ARM_F;
  public spsrRegs: Record<number, number> = {};
  public halted: boolean = false;
  /** Cycles consumed by the instruction executed in the last `step()`. */
  public cycles: number = 0;

  private fiqR8to12: Uint32Array = new Uint32Array(5);
  private usrR8to12: Uint32Array = new Uint32Array(5);
  private bankedSpLr: Record<number, [number, number]> = {
    [MODE_FIQ]: [0, 0],
    [MODE_IRQ]: [0, 0],
    [MODE_SVC]: [0, 0],
    [MODE_ABT]: [0, 0],
    [MODE_UND]: [0, 0],
  };

  private thumbBlOffset: number = 0;

  // Barrel-shifter scratch values (avoids object allocation per instruction).
  private shifted: number = 0;
  private shiftCarryOut: number = 0;

  public readonly bus: ArmBus;
  public readonly hooks: ArmHooks;

  constructor(bus: ArmBus, hooks: ArmHooks) {
    this.bus = bus;
    this.hooks = hooks;
    this.reset();
  }

  // ---- Register / flag access --------------------------------------------

  get mode(): number {
    return this.cpsr & 0x1f;
  }

  get thumb(): boolean {
    return (this.cpsr & ARM_T) !== 0;
  }

  setFlag(mask: number, on: boolean): void {
    this.cpsr = on ? (this.cpsr | mask) >>> 0 : (this.cpsr & ~mask) >>> 0;
  }

  getFlag(mask: number): boolean {
    return (this.cpsr & mask) !== 0;
  }

  /**
   * Register value as seen by an instruction. During execution r15 already
   * points at the next instruction, so the pipeline bias is +4 (ARM) / +2
   * (Thumb).
   */
  getReg(index: number): number {
    if (index === 15) return (this.r[15] + (this.thumb ? 2 : 4)) >>> 0;
    return this.r[index];
  }

  setReg(index: number, value: number): void {
    this.r[index] = value >>> 0;
  }

  setNZ(result: number): void {
    this.cpsr =
      ((this.cpsr & ~(ARM_N | ARM_Z)) |
        (result === 0 ? ARM_Z : 0) |
        (result & ARM_N ? ARM_N : 0)) >>>
      0;
  }

  sspSpsr(mode: number): number {
    return this.spsrRegs[mode] ?? 0;
  }

  private switchMode(newMode: number): void {
    const oldMode = this.mode;
    if (oldMode === newMode) return;

    if (oldMode === MODE_FIQ) {
      this.fiqR8to12.set(this.r.subarray(8, 13));
      this.r.set(this.usrR8to12, 8);
    }
    const oldBank = this.bankedSpLr[oldMode];
    if (oldBank) {
      oldBank[0] = this.r[13];
      oldBank[1] = this.r[14];
    }

    this.cpsr = ((this.cpsr & ~0x1f) | newMode) >>> 0;

    if (newMode === MODE_FIQ) {
      this.usrR8to12.set(this.r.subarray(8, 13));
      this.r.set(this.fiqR8to12, 8);
    }
    const newBank = this.bankedSpLr[newMode];
    if (newBank) {
      this.r[13] = newBank[0];
      this.r[14] = newBank[1];
    }
  }

  /** Public mode switch used by the HLE BIOS interrupt dispatcher. */
  switchTo(mode: number): void {
    this.switchMode(mode);
  }

  /** Enter an exception vector, banking LR/CPSR like the ARM7TDMI. */
  exception(vector: number, mode: number, returnAddress: number): void {
    this.spsrRegs[mode] = this.cpsr >>> 0;
    this.switchMode(mode);
    this.r[14] = returnAddress >>> 0;
    this.cpsr = ((this.cpsr | ARM_I) & ~ARM_T) >>> 0;
    this.r[15] = vector >>> 0;
  }

  reset(): void {
    this.r.fill(0);
    this.cpsr = MODE_SYS | ARM_I | ARM_F;
    this.spsrRegs = {};
    for (const mode of SPRSR_MODES) this.spsrRegs[mode] = 0;
    for (const key of Object.keys(this.bankedSpLr)) this.bankedSpLr[Number(key)] = [0, 0];
    this.fiqR8to12.fill(0);
    this.usrR8to12.fill(0);
    this.halted = false;
    this.cycles = 0;
    this.thumbBlOffset = 0;
  }

  /** Registers/stack as the GBA BIOS leaves them after boot. */
  bootState(entryPoint: number): void {
    this.reset();
    this.bankedSpLr[MODE_IRQ] = [0x03007fa0, 0];
    this.bankedSpLr[MODE_SVC] = [0x03007fe0, 0];
    this.bankedSpLr[MODE_ABT] = [0x03007fe0, 0];
    this.bankedSpLr[MODE_UND] = [0x03007fe0, 0];
    this.bankedSpLr[MODE_FIQ] = [0x03007fa0, 0];
    // Real hardware leaves the CPU in System mode with CPSR.I/F clear; the
    // interrupt master enable (IME) is off until the game enables it.
    this.cpsr = MODE_SYS;
    this.r[13] = 0x03007f00;
    this.r[15] = entryPoint >>> 0;
    this.r[0] = 0;
    this.r[1] = 0;
  }

  // ---- Barrel shifter -----------------------------------------------------

  private shiftImm(value: number, type: number, amount: number, carryIn: boolean): void {
    switch (type) {
      case 0: // LSL
        if (amount === 0) {
          this.shifted = value >>> 0;
          this.shiftCarryOut = carryIn ? 1 : 0;
        } else {
          this.shiftCarryOut = (value >>> (32 - amount)) & 1;
          this.shifted = (value << amount) >>> 0;
        }
        break;
      case 1: // LSR
        if (amount === 0) amount = 32;
        this.shiftCarryOut = amount === 32 ? (value >>> 31) & 1 : (value >>> (amount - 1)) & 1;
        this.shifted = amount === 32 ? 0 : value >>> amount;
        break;
      case 2: // ASR
        if (amount === 0) amount = 32;
        this.shiftCarryOut = (value >>> (amount - 1)) & 1;
        this.shifted = (value >> amount) >>> 0;
        break;
      default: {
        // ROR / RRX
        if (amount === 0) {
          const carry = carryIn ? 1 : 0;
          this.shiftCarryOut = value & 1;
          this.shifted = ((value >>> 1) | (carry << 31)) >>> 0;
        } else {
          const rot = amount & 31;
          this.shiftCarryOut = (value >>> (rot - 1)) & 1;
          this.shifted = rot === 0 ? value >>> 0 : ((value >>> rot) | (value << (32 - rot))) >>> 0;
        }
        break;
      }
    }
  }

  private shiftReg(value: number, type: number, amount: number, carryIn: boolean): void {
    if (amount === 0) {
      this.shifted = value >>> 0;
      this.shiftCarryOut = carryIn ? 1 : 0;
      return;
    }
    if (type === 3 && (amount & 31) === 0) {
      this.shifted = value >>> 0;
      this.shiftCarryOut = (value >>> 31) & 1;
      return;
    }
    this.shiftImm(value, type, amount & 0xff, carryIn);
  }

  // ---- Execution ----------------------------------------------------------

  /** Execute one instruction, returning 16.78 MHz cycles consumed. */
  step(): number {
    if (this.halted) {
      if (!this.hooks.haltWake()) {
        this.cycles = 1;
        return this.cycles;
      }
      this.halted = false;
    }

    const addr = this.r[15] >>> 0;

    // HLE BIOS IRQ epilogue, reached through the handler's `bx lr`.
    if (addr === IRQ_RETURN_MARKER) {
      this.hooks.leaveIrq(this);
      this.cycles = 1;
      return this.cycles;
    }

    if (!(this.cpsr & ARM_I) && this.hooks.irqPending()) {
      this.hooks.enterIrq(this);
      this.cycles = 1;
      return this.cycles;
    }

    this.cycles = 1;
    if (this.thumb) {
      const instr = this.bus.read16(addr);
      this.r[15] = (addr + 2) >>> 0;
      THUMB_TABLE[instr >>> 8](this, instr);
    } else {
      const instr = this.bus.read32(addr);
      this.r[15] = (addr + 4) >>> 0;
      if (CONDITION[(instr >>> 28) & 0xf](this)) {
        ARM_TABLE[(instr >>> 20) & 0xff](this, instr);
      }
    }
    return this.cycles;
  }

  // ---- Shared helpers -----------------------------------------------------

  private armReadOperand2(instr: number): void {
    const carryIn = this.getFlag(ARM_C);
    if (instr & (1 << 25)) {
      const imm = instr & 0xff;
      const rot = ((instr >>> 8) & 0xf) * 2;
      const value = rot === 0 ? imm : ((imm >>> rot) | (imm << (32 - rot))) >>> 0;
      this.shifted = value;
      this.shiftCarryOut = rot === 0 ? (carryIn ? 1 : 0) : (value >>> 31) & 1;
      return;
    }
    const rm = instr & 0xf;
    const type = (instr >>> 5) & 0x3;
    if (instr & (1 << 4)) {
      const rs = (instr >>> 8) & 0xf;
      let amount = this.getReg(rs) & 0xff;
      if (rs === 15) amount += 4;
      this.shiftReg(this.getReg(rm), type, amount, carryIn);
    } else {
      this.shiftImm(this.getReg(rm), type, (instr >>> 7) & 0x1f, carryIn);
    }
  }

  private addWithCarry(a: number, b: number, carry: number, setFlags = true): number {
    const sum = a + b + carry;
    const result = sum >>> 0;
    if (setFlags) {
      const overflow = (~(a ^ b) & (a ^ result) & ARM_N) !== 0;
      this.cpsr =
        ((this.cpsr & ~(ARM_N | ARM_Z | ARM_C | ARM_V)) |
          (result === 0 ? ARM_Z : 0) |
          (result & ARM_N ? ARM_N : 0) |
          (sum > 0xffffffff ? ARM_C : 0) |
          (overflow ? ARM_V : 0)) >>>
        0;
    }
    return result;
  }

  private subWithCarry(a: number, b: number, carry: number, setFlags = true): number {
    const result = (a - b - carry) >>> 0;
    if (setFlags) {
      const borrow = a < b + carry;
      const overflow = ((a ^ b) & (a ^ result) & ARM_N) !== 0;
      this.cpsr =
        ((this.cpsr & ~(ARM_N | ARM_Z | ARM_C | ARM_V)) |
          (result === 0 ? ARM_Z : 0) |
          (result & ARM_N ? ARM_N : 0) |
          (borrow ? 0 : ARM_C) |
          (overflow ? ARM_V : 0)) >>>
        0;
    }
    return result;
  }

  /** N/Z from a result, C from the barrel shifter when the ARM form sets S. */
  private setLogicFlags(result: number, updateCarry = true): void {
    let cpsr =
      (this.cpsr & ~(ARM_N | ARM_Z)) |
      (result === 0 ? ARM_Z : 0) |
      (result & ARM_N ? ARM_N : 0);
    if (updateCarry) cpsr = (cpsr & ~ARM_C) | (this.shiftCarryOut ? ARM_C : 0);
    this.cpsr = cpsr >>> 0;
  }

  private writeFlagsFromResult(result: number): void {
    this.cpsr =
      ((this.cpsr & ~(ARM_N | ARM_Z)) |
        (result === 0 ? ARM_Z : 0) |
        (result & ARM_N ? ARM_N : 0)) >>>
      0;
  }

  private armDataProcessing(instr: number): void {
    const opcode = (instr >>> 21) & 0xf;
    const s = (instr >>> 20) & 1;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;

    this.armReadOperand2(instr);
    const op1 = this.getReg(rn);
    const op2 = this.shifted;
    const carry = this.getFlag(ARM_C) ? 1 : 0;
    let result = 0;

    switch (opcode) {
      case 0x0:
        result = (op1 & op2) >>> 0;
        break;
      case 0x1:
        result = (op1 ^ op2) >>> 0;
        break;
      case 0x2:
        result = this.subWithCarry(op1, op2, 0, s === 1);
        break;
      case 0x3:
        result = this.subWithCarry(op2, op1, 0, s === 1);
        break;
      case 0x4:
        result = this.addWithCarry(op1, op2, 0, s === 1);
        break;
      case 0x5:
        result = this.addWithCarry(op1, op2, carry, s === 1);
        break;
      case 0x6:
        result = this.subWithCarry(op1, op2, carry, s === 1);
        break;
      case 0x7:
        result = this.subWithCarry(op2, op1, carry, s === 1);
        break;
      case 0x8: // TST
        this.setLogicFlags((op1 & op2) >>> 0);
        return;
      case 0x9: // TEQ
        this.setLogicFlags((op1 ^ op2) >>> 0);
        return;
      case 0xa: // CMP
        this.subWithCarry(op1, op2, 0);
        return;
      case 0xb: // CMN
        this.addWithCarry(op1, op2, 0);
        return;
      case 0xc:
        result = (op1 | op2) >>> 0;
        break;
      case 0xd:
        result = op2;
        break;
      case 0xe:
        result = (op1 & ~op2) >>> 0;
        break;
      default:
        result = (~op2) >>> 0;
        break;
    }

    if (opcode <= 0x1 || opcode >= 0xc) {
      // Logical operations update N/Z (+C from the shifter) when S is set.
      if (s) this.setLogicFlags(result);
    }

    if (rd === 15) {
      this.setReg(15, result & ~1);
      if (s) {
        // Exception return: CPSR is restored from the current mode's SPSR.
        this.cpsr = this.sspSpsr(this.mode);
      }
      this.cycles += 1;
      return;
    }
    this.setReg(rd, result);
  }

  private armPsrTransfer(instr: number): void {
    const rd = (instr >>> 12) & 0xf;
    if ((instr & (1 << 21)) === 0) {
      // MRS
      this.setReg(rd, instr & (1 << 22) ? this.sspSpsr(this.mode) : this.cpsr);
      return;
    }
    // MSR
    let value: number;
    if (instr & (1 << 25)) {
      const imm = instr & 0xff;
      const rot = ((instr >>> 8) & 0xf) * 2;
      value = rot === 0 ? imm : ((imm >>> rot) | (imm << (32 - rot))) >>> 0;
    } else {
      value = this.getReg(instr & 0xf);
    }
    const mask = (instr >>> 16) & 0xf;
    const isSpsr = (instr & (1 << 22)) !== 0;
    if (isSpsr) {
      let v = this.sspSpsr(this.mode);
      if (mask & 8) v = (v & 0x00ffffff) | (value & 0xff000000);
      if (mask & 4) v = (v & 0xff00ffff) | (value & 0x00ff0000);
      if (mask & 2) v = (v & 0xffff00ff) | (value & 0x0000ff00);
      if (mask & 1) v = (v & 0xffffff00) | (value & 0x000000ff);
      this.spsrRegs[this.mode] = v >>> 0;
      return;
    }
    if (mask & 8) this.cpsr = ((this.cpsr & 0x00ffffff) | (value & 0xff000000)) >>> 0;
    if (mask & 4) this.cpsr = ((this.cpsr & 0xff00ffff) | (value & 0x00ff0000)) >>> 0;
    if (mask & 2) this.cpsr = ((this.cpsr & 0xffff00ff) | (value & 0x0000ff00)) >>> 0;
    if (mask & 1) {
      const newMode = value & 0x1f;
      if (newMode !== this.mode) this.switchMode(newMode);
      this.cpsr = ((this.cpsr & ~0xff) | (value & 0xff)) >>> 0;
    }
  }

  private armMultiply(instr: number): void {
    const rd = (instr >>> 16) & 0xf;
    const rn = (instr >>> 12) & 0xf;
    const rs = (instr >>> 8) & 0xf;
    const rm = instr & 0xf;
    const accumulate = (instr & (1 << 21)) !== 0;
    const setFlags = (instr & (1 << 20)) !== 0;
    const opA = this.getReg(rm);
    const opB = this.getReg(rs);

    if ((instr & (1 << 23)) === 0) {
      const result = (Math.imul(opA, opB) + (accumulate ? this.getReg(rn) : 0)) >>> 0;
      this.setReg(rd, result);
      if (setFlags) this.writeFlagsFromResult(result);
      this.cycles += 2;
      return;
    }

    // Long multiply (64-bit product, optional accumulate). The product is
    // built from 16-bit halves because a 32x32 product does not fit in a
    // double without losing bits.
    const rdHi = rd;
    const rdLo = rn;
    const signed = (instr & (1 << 22)) !== 0;
    let low: number;
    let high: number;
    {
      const product = Arm7tdmi.mul64(opA, opB, signed);
      low = product[0];
      high = product[1];
    }
    if (accumulate) {
      const sum = low + this.r[rdLo];
      const carry = sum > 0xffffffff ? 1 : 0;
      low = sum >>> 0;
      high = (high + this.r[rdHi] + carry) >>> 0;
    }
    this.setReg(rdLo, low);
    this.setReg(rdHi, high);
    if (setFlags) {
      this.cpsr =
        ((this.cpsr & ~(ARM_N | ARM_Z)) |
          (high & ARM_N ? ARM_N : 0) |
          (low === 0 && high === 0 ? ARM_Z : 0)) >>>
        0;
    }
    this.cycles += 3;
  }

  private armSwap(instr: number): void {
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;
    const rm = instr & 0xf;
    const byte = (instr & (1 << 22)) !== 0;
    const addr = this.getReg(rn);
    if (byte) {
      const tmp = this.bus.read8(addr);
      this.bus.write8(addr, this.getReg(rm) & 0xff);
      this.setReg(rd, tmp);
    } else {
      const tmp = this.bus.read32(addr);
      this.bus.write32(addr, this.getReg(rm));
      this.setReg(rd, tmp);
    }
    this.cycles += 3;
  }

  private armHalfwordTransfer(instr: number): void {
    const immediate = (instr & (1 << 22)) !== 0;
    const pre = (instr & (1 << 24)) !== 0;
    const up = (instr & (1 << 23)) !== 0;
    const writeback = (instr & (1 << 21)) !== 0;
    const load = (instr & (1 << 20)) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;
    const sh = (instr >>> 5) & 0x3;
    const offset = immediate
      ? (((instr >>> 8) & 0xf) << 4) | (instr & 0xf)
      : this.getReg(instr & 0xf);

    const base = this.getReg(rn);
    const addr = pre ? (up ? base + offset : base - offset) : base;
    const newBase = up ? base + offset : base - offset;

    if (load) {
      let value = this.bus.read16(addr & ~1);
      if (addr & 1) value = ((value >>> 8) | (value << 8)) & 0xffff;
      if (sh === 1) this.setReg(rd, value);
      else if (sh === 2) this.setReg(rd, sign8(this.bus.read8(addr)));
      else this.setReg(rd, (value << 16) >> 16);
      this.cycles += 2;
    } else {
      this.bus.write16(addr & ~1, this.getReg(rd) & 0xffff);
      this.cycles += 1;
    }
    if (!pre || writeback) this.setReg(rn, newBase);
  }

  private armSingleTransfer(instr: number): void {
    const immediateOffset = (instr & (1 << 25)) === 0;
    const pre = (instr & (1 << 24)) !== 0;
    const up = (instr & (1 << 23)) !== 0;
    const byte = (instr & (1 << 22)) !== 0;
    const writeback = (instr & (1 << 21)) !== 0;
    const load = (instr & (1 << 20)) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const rd = (instr >>> 12) & 0xf;

    let offset: number;
    if (immediateOffset) {
      offset = instr & 0xfff;
    } else {
      this.shiftImm(
        this.getReg(instr & 0xf),
        (instr >>> 5) & 0x3,
        (instr >>> 7) & 0x1f,
        this.getFlag(ARM_C)
      );
      offset = this.shifted;
    }

    const base = this.getReg(rn);
    const addr = pre ? (up ? base + offset : base - offset) : base;
    const newBase = up ? base + offset : base - offset;

    if (load) {
      if (byte) {
        this.setReg(rd, this.bus.read8(addr));
      } else {
        const value = this.bus.read32(addr & ~3);
        const rot = (addr & 3) * 8;
        this.setReg(rd, rot ? ((value >>> rot) | (value << (32 - rot))) >>> 0 : value);
      }
      if (rd === 15) this.cycles += 1;
      this.cycles += 2;
    } else {
      if (byte) this.bus.write8(addr, this.getReg(rd) & 0xff);
      else this.bus.write32(addr & ~3, this.getReg(rd));
      this.cycles += 1;
    }
    if (!pre || writeback) {
      if (!(load && rd === rn)) this.setReg(rn, newBase);
    }
  }

  private armBlockTransfer(instr: number): void {
    const pre = (instr & (1 << 24)) !== 0;
    const up = (instr & (1 << 23)) !== 0;
    const load = (instr & (1 << 20)) !== 0;
    const writeback = (instr & (1 << 21)) !== 0;
    const rn = (instr >>> 16) & 0xf;
    const list = instr & 0xffff;
    let count = 0;
    for (let i = 0; i < 16; i++) if (list & (1 << i)) count++;
    if (count === 0) count = 16;

    const base = this.getReg(rn);
    let address = up
      ? pre
        ? base + 4
        : base
      : base - count * 4 + (pre ? 0 : 4);

    for (let i = 0; i < 16; i++) {
      if ((list & (1 << i)) === 0) continue;
      if (load) {
        const value = this.bus.read32(address & ~3);
        if (i === 15) this.setReg(15, value & ~1);
        else this.setReg(i, value);
      } else {
        this.bus.write32(address & ~3, i === 15 ? this.getReg(15) : this.r[i]);
      }
      address += 4;
    }

    if (writeback) {
      const newBase = up ? base + count * 4 : base - count * 4;
      if (!(load && (list & (1 << rn)))) this.setReg(rn, newBase);
    }
    this.cycles += count + 1;
  }

  private armBranch(instr: number): void {
    const offset = sign24(instr & 0xffffff) * 4;
    if (instr & (1 << 24)) this.setReg(14, this.r[15]);
    this.setReg(15, (this.r[15] + 4 + offset) >>> 0);
    this.cycles += 2;
  }

  private armBx(instr: number): void {
    const target = this.getReg(instr & 0xf);
    this.cpsr = ((this.cpsr & ~ARM_T) | (target & 1 ? ARM_T : 0)) >>> 0;
    this.setReg(15, target & ~1);
    this.cycles += 2;
  }

  private armSwi(instr: number): void {
    const number = (instr >>> 16) & 0xff;
    if (number === 0x02 || number === 0x03) {
      this.halted = true;
      return;
    }
    this.hooks.swi(this, number);
    this.cycles += 2;
  }

  private undefined(_instr: number): void {
    this.exception(0x04, MODE_UND, this.r[15]);
    this.cycles += 1;
  }

  /** Group of "extra" ARM encodings (bit 4 set, bit 7 clear). */
  /**
   * Group `000` (bits 27-26 = 00) instructions other than plain data
   * processing: multiply, swap/BX, extra (halfword/signed) transfers.
   *
   * Decoding follows the ARM ARM: a register-shifted data-processing
   * instruction has bits 6-5 = 00 (LSL), while every extra transfer sets at
   * least one of them, so only the 1001 pattern can be a multiply/swap.
   */
  private armMisc(instr: number): void {
    const bit25 = (instr & (1 << 25)) !== 0;
    if (bit25) {
      // MSR with an immediate operand (bits 27-23 = 00110, bit 21 = 1).
      if (((instr >>> 23) & 0x1f) === 0x6 && (instr & (1 << 21)) !== 0) {
        return this.armPsrTransfer(instr);
      }
      return this.armDataProcessing(instr);
    }
    if ((instr & 0x90) === 0x90) {
      if ((instr & 0x60) !== 0) {
        // LDRD/STRD use bits 6-5 = 10 with bit 20 = 0; ARMv5 only.
        if ((instr & 0x60) === 0x40 && (instr & (1 << 20)) === 0) {
          return this.undefined(instr);
        }
        return this.armHalfwordTransfer(instr);
      }
      return this.armExtra(instr);
    }
    // BX: bits 27-4 = 0x012fff10 | Rm.
    if ((instr & 0x0ffffff0) === 0x012fff10) return this.armBx(instr);
    // MRS/MSR (register form): bits 27-23 = 00010.
    if (((instr >>> 23) & 0x1f) === 0x2) return this.armPsrTransfer(instr);
    return this.armDataProcessing(instr);
  }

  /** Multiply, swap/BX; anything else in this slot is data processing. */
  private armExtra(instr: number): void {
    // MUL/MLA have bits 27-23 = 00000, the long multiplies 00001.
    const mulGroup = (instr >>> 23) & 0x3;
    if (mulGroup === 0 || mulGroup === 1) return this.armMultiply(instr);
    if (
      ((instr >>> 23) & 0x1f) === 0x2 &&
      (instr & (1 << 22)) === 0 &&
      (instr & (1 << 20)) === 0
    ) {
      // BX shares bits 27-20 with SWP; bits 19-4 are all 1 for BX.
      if ((instr & 0x0fffff00) === 0x012fff00) return this.armBx(instr);
      return this.armSwap(instr);
    }
    return this.armDataProcessing(instr);
  }

  // ---- Thumb instructions -------------------------------------------------

  private thumbShiftImm(instr: number): void {
    const type = (instr >>> 11) & 0x3;
    const imm5 = (instr >>> 6) & 0x1f;
    const rs = (instr >>> 3) & 0x7;
    const rd = instr & 0x7;
    const value = this.r[rs];
    if (type === 0 && imm5 === 0) {
      this.r[rd] = value;
      return;
    }
    this.shiftImm(value, type, imm5, this.getFlag(ARM_C));
    this.r[rd] = this.shifted;
    this.writeFlagsFromResult(this.shifted);
    this.cpsr = ((this.cpsr & ~ARM_C) | (this.shiftCarryOut ? ARM_C : 0)) >>> 0;
  }

  /** Thumb format 2 (`00011 I op`): ADD/SUB register or 3-bit immediate. */
  private thumbAddSub(instr: number): void {
    const immediate = (instr & 0x400) !== 0;
    const subtract = (instr & 0x200) !== 0;
    const rs = (instr >>> 3) & 0x7;
    const rd = instr & 0x7;
    const operand = immediate ? (instr >>> 6) & 0x7 : this.r[rs];
    this.r[rd] = subtract
      ? this.subWithCarry(this.r[rs], operand, 0)
      : this.addWithCarry(this.r[rs], operand, 0);
  }

  /** Thumb format 3 (`001 op`): MOV/CMP/ADD/SUB with an 8-bit immediate. */
  private thumbMovCmpAddSub(instr: number): void {
    const op = (instr >>> 11) & 0x3;
    const rd = (instr >>> 8) & 0x7;
    const imm8 = instr & 0xff;
    if (op === 0) {
      this.r[rd] = imm8;
      this.writeFlagsFromResult(imm8);
    } else if (op === 1) {
      this.subWithCarry(this.r[rd], imm8, 0);
    } else if (op === 2) {
      this.r[rd] = this.addWithCarry(this.r[rd], imm8, 0);
    } else {
      this.r[rd] = this.subWithCarry(this.r[rd], imm8, 0);
    }
  }

  private thumbAlu(instr: number): void {
    const op = (instr >>> 6) & 0xf;
    const rs = (instr >>> 3) & 0x7;
    const rd = instr & 0x7;
    const a = this.r[rd];
    const b = this.r[rs];
    const carry = this.getFlag(ARM_C) ? 1 : 0;

    switch (op) {
      case 0x0:
        this.r[rd] = (a & b) >>> 0;
        this.setLogicFlags(this.r[rd], false);
        return;
      case 0x1:
        this.r[rd] = (a ^ b) >>> 0;
        this.setLogicFlags(this.r[rd], false);
        return;
      case 0x2:
      case 0x3:
      case 0x4:
      case 0x7: {
        const type = op === 0x2 ? 0 : op === 0x3 ? 1 : op === 0x4 ? 2 : 3;
        this.shiftReg(a, type, b & 0xff, this.getFlag(ARM_C));
        this.r[rd] = this.shifted;
        this.writeFlagsFromResult(this.shifted);
        this.cpsr = ((this.cpsr & ~ARM_C) | (this.shiftCarryOut ? ARM_C : 0)) >>> 0;
        return;
      }
      case 0x5:
        this.r[rd] = this.addWithCarry(a, b, carry);
        return;
      case 0x6:
        this.r[rd] = this.subWithCarry(a, b, carry);
        return;
      case 0x8:
        this.setLogicFlags((a & b) >>> 0, false);
        return;
      case 0x9:
        this.r[rd] = this.subWithCarry(0, a, 0);
        return;
      case 0xa:
        this.subWithCarry(a, b, 0);
        return;
      case 0xb:
        this.addWithCarry(a, b, 0);
        return;
      case 0xc:
        this.r[rd] = (a | b) >>> 0;
        this.setLogicFlags(this.r[rd], false);
        return;
      case 0xd: {
        const result = Math.imul(a, b) >>> 0;
        this.r[rd] = result;
        this.writeFlagsFromResult(result);
        this.cycles += 1;
        return;
      }
      case 0xe:
        this.r[rd] = (a & ~b) >>> 0;
        this.setLogicFlags(this.r[rd], false);
        return;
      default:
        this.r[rd] = (~b) >>> 0;
        this.setLogicFlags(this.r[rd], false);
        return;
    }
  }

  private thumbHiReg(instr: number): void {
    const op = (instr >>> 8) & 0x3;
    const rs = ((instr >>> 3) & 0x7) | (instr & 0x40 ? 8 : 0);
    const rd = (instr & 0x7) | (instr & 0x80 ? 8 : 0);
    const a = this.getReg(rd);
    const b = this.getReg(rs);

    if (op === 3) {
      this.cpsr = ((this.cpsr & ~ARM_T) | (b & 1 ? ARM_T : 0)) >>> 0;
      this.setReg(15, b & ~1);
      this.cycles += 2;
      return;
    }
    if (op === 0) {
      this.setReg(rd, (a + b) >>> 0);
      return;
    }
    if (op === 1) {
      this.subWithCarry(a, b, 0);
      return;
    }
    this.setReg(rd, b);
  }

  private thumbLdrPc(instr: number): void {
    const rd = (instr >>> 8) & 0x7;
    const addr = ((this.getReg(15) & ~3) + (instr & 0xff) * 4) >>> 0;
    this.r[rd] = this.bus.read32(addr & ~3);
    this.cycles += 2;
  }

  private thumbLoadStoreReg(instr: number): void {
    const op = (instr >>> 9) & 0x7;
    const ro = (instr >>> 6) & 0x7;
    const rb = (instr >>> 3) & 0x7;
    const rd = instr & 0x7;
    const addr = (this.r[rb] + this.r[ro]) >>> 0;
    switch (op) {
      case 0:
        this.bus.write32(addr & ~3, this.r[rd]);
        this.cycles += 1;
        return;
      case 1:
        this.bus.write16(addr & ~1, this.r[rd] & 0xffff);
        this.cycles += 1;
        return;
      case 2:
        this.bus.write8(addr, this.r[rd] & 0xff);
        this.cycles += 1;
        return;
      case 3:
        this.r[rd] = sign8(this.bus.read8(addr));
        this.cycles += 2;
        return;
      case 4: {
        const value = this.bus.read32(addr & ~3);
        const rot = (addr & 3) * 8;
        this.r[rd] = rot ? ((value >>> rot) | (value << (32 - rot))) >>> 0 : value;
        this.cycles += 2;
        return;
      }
      case 5:
        this.r[rd] = this.bus.read16(addr & ~1);
        this.cycles += 2;
        return;
      case 6:
        this.r[rd] = this.bus.read8(addr);
        this.cycles += 2;
        return;
      default: {
        let value = this.bus.read16(addr & ~1);
        if (addr & 1) value = ((value >>> 8) | (value << 8)) & 0xffff;
        this.r[rd] = (value << 16) >> 16;
        this.cycles += 2;
        return;
      }
    }
  }

  private thumbLoadStoreImm(instr: number): void {
    const byte = (instr & 0x1000) !== 0;
    const load = (instr & 0x0800) !== 0;
    const imm = (instr >>> 6) & 0x1f;
    const rb = (instr >>> 3) & 0x7;
    const rd = instr & 0x7;
    if (byte) {
      const addr = (this.r[rb] + imm) >>> 0;
      if (load) this.r[rd] = this.bus.read8(addr);
      else this.bus.write8(addr, this.r[rd] & 0xff);
    } else {
      const addr = (this.r[rb] + imm * 4) >>> 0;
      if (load) this.r[rd] = this.bus.read32(addr & ~3);
      else this.bus.write32(addr & ~3, this.r[rd]);
    }
    this.cycles += load ? 2 : 1;
  }

  private thumbLoadStoreHalf(instr: number): void {
    const load = (instr & 0x0800) !== 0;
    const imm = ((instr >>> 6) & 0x1f) * 2;
    const rb = (instr >>> 3) & 0x7;
    const rd = instr & 0x7;
    const addr = (this.r[rb] + imm) >>> 0;
    if (load) this.r[rd] = this.bus.read16(addr & ~1);
    else this.bus.write16(addr & ~1, this.r[rd] & 0xffff);
    this.cycles += load ? 2 : 1;
  }

  private thumbSpRel(instr: number): void {
    const load = (instr & 0x0800) !== 0;
    const rd = (instr >>> 8) & 0x7;
    const addr = (this.r[13] + (instr & 0xff) * 4) >>> 0;
    if (load) this.r[rd] = this.bus.read32(addr & ~3);
    else this.bus.write32(addr & ~3, this.r[rd]);
    this.cycles += load ? 2 : 1;
  }

  private thumbLoadAddress(instr: number): void {
    const rd = (instr >>> 8) & 0x7;
    const base = instr & 0x0800 ? this.r[13] : this.getReg(15) & ~3;
    this.r[rd] = (base + (instr & 0xff) * 4) >>> 0;
  }

  private thumbAdjustSp(instr: number): void {
    const offset = (instr & 0x7f) * 4;
    this.r[13] = (instr & 0x80 ? this.r[13] - offset : this.r[13] + offset) >>> 0;
  }

  private thumbPushPop(instr: number): void {
    const load = (instr & 0x0800) !== 0;
    const extra = (instr & 0x100) !== 0;
    const list = instr & 0xff;
    let count = 0;
    for (let i = 0; i < 8; i++) if (list & (1 << i)) count++;
    if (extra) count++;

    if (load) {
      let addr = this.r[13];
      for (let i = 0; i < 8; i++) {
        if ((list & (1 << i)) === 0) continue;
        this.r[i] = this.bus.read32(addr & ~3);
        addr += 4;
      }
      if (extra) this.setReg(15, this.bus.read32(addr & ~3) & ~1);
      this.r[13] = (this.r[13] + count * 4) >>> 0;
    } else {
      const addr = (this.r[13] - count * 4) >>> 0;
      this.r[13] = addr;
      let cursor = addr;
      for (let i = 0; i < 8; i++) {
        if ((list & (1 << i)) === 0) continue;
        this.bus.write32(cursor & ~3, this.r[i]);
        cursor += 4;
      }
      if (extra) this.bus.write32(cursor & ~3, this.r[14]);
    }
    this.cycles += count + 1;
  }

  private thumbLdmStm(instr: number): void {
    const load = (instr & 0x0800) !== 0;
    const rb = (instr >>> 8) & 0x7;
    const list = instr & 0xff;
    let count = 0;
    for (let i = 0; i < 8; i++) if (list & (1 << i)) count++;
    if (count === 0) count = 8;

    let addr = this.r[rb];
    for (let i = 0; i < 8; i++) {
      if ((list & (1 << i)) === 0) continue;
      if (load) this.r[i] = this.bus.read32(addr & ~3);
      else this.bus.write32(addr & ~3, this.r[i]);
      addr += 4;
    }
    if (!(load && (list & (1 << rb)))) this.r[rb] = addr >>> 0;
    this.cycles += count + 1;
  }

  private thumbCondBranch(instr: number): void {
    if (!CONDITION[(instr >>> 8) & 0xf](this)) return;
    this.setReg(15, (this.getReg(15) + sign8(instr & 0xff) * 2) >>> 0);
    this.cycles += 2;
  }

  private thumbBranch(instr: number): void {
    this.setReg(15, (this.getReg(15) + sign11(instr & 0x7ff) * 2) >>> 0);
    this.cycles += 2;
  }

  private thumbBlFirst(instr: number): void {
    this.thumbBlOffset = sign11(instr & 0x7ff) << 12;
  }

  private thumbBlSecond(instr: number): void {
    const offset = this.thumbBlOffset + ((instr & 0x7ff) << 1);
    this.setReg(14, (this.getReg(15) - 2) | 1);
    this.setReg(15, (this.getReg(15) + offset) >>> 0);
    this.cycles += 3;
  }

  private thumbSwi(instr: number): void {
    const number = instr & 0xff;
    if (number === 0x02 || number === 0x03) {
      this.halted = true;
      return;
    }
    this.hooks.swi(this, number);
    this.cycles += 2;
  }

  /** Exact 64-bit multiply returning [low, high] words. */
  private static mul64(a: number, b: number, signed: boolean): [number, number] {
    const aLo = a & 0xffff;
    const aHi = (a >>> 16) & 0xffff;
    const bLo = b & 0xffff;
    const bHi = (b >>> 16) & 0xffff;

    const p0 = aLo * bLo;
    const p1 = aLo * bHi;
    const p2 = aHi * bLo;
    const p3 = aHi * bHi;

    const mid = (p0 >>> 16) + (p1 & 0xffff) + (p2 & 0xffff);
    let low = (((mid & 0xffff) << 16) | (p0 & 0xffff)) >>> 0;
    let high = (p3 + (p1 >>> 16) + (p2 >>> 16) + (mid >>> 16)) >>> 0;

    if (signed) {
      // Two's-complement correction for negative operands.
      if (a & 0x80000000) high = (high - b) >>> 0;
      if (b & 0x80000000) high = (high - a) >>> 0;
      // A negative result needs the 2^64 term folded back in, which the
      // subtraction above already performs modulo 2^64.
      if ((a & 0x80000000) && (b & 0x80000000)) {
        low = low >>> 0;
      }
    }
    return [low, high];
  }

  // ---- Save states --------------------------------------------------------

  getState(): Uint32Array {
    const state = new Uint32Array(32);
    state.set(this.r, 0);
    state[16] = this.cpsr;
    for (let i = 0; i < 7; i++) state[17 + i] = this.spsrRegs[SPRSR_MODES[i]] ?? 0;
    for (let i = 0; i < 5; i++) state[24 + i] = this.fiqR8to12[i];
    state[29] = this.halted ? 1 : 0;
    state[30] = this.thumbBlOffset >>> 0;
    state[31] = 0;
    return state;
  }

  setState(state: Uint32Array): void {
    this.r.set(state.subarray(0, 16));
    this.cpsr = state[16] >>> 0;
    for (let i = 0; i < 7; i++) this.spsrRegs[SPRSR_MODES[i]] = state[17 + i] >>> 0;
    for (let i = 0; i < 5; i++) this.fiqR8to12[i] = state[24 + i] >>> 0;
    this.halted = (state[29] & 1) !== 0;
    this.thumbBlOffset = state[30] | 0;
    for (const mode of Object.keys(this.bankedSpLr)) {
      this.bankedSpLr[Number(mode)] = [0, 0];
    }
    this.bankedSpLr[this.mode] = [this.r[13], this.r[14]];
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = { cpsr: this.cpsr >>> 0 };
    for (let i = 0; i < 16; i++) out[`r${i}`] = this.r[i];
    return out;
  }
}

// ---------------------------------------------------------------------------
// ARM dispatch table, indexed by instruction bits 27-20 (256 entries).
// Sub-decoding of operand bits (register vs. immediate, multiply vs. data
// processing, ...) happens inside the handler so operand fields never change
// the slot an instruction maps to.

const ARM_TABLE: ArmHandler[] = new Array(256);

function classifyArm(op24: number): ArmHandler {
  const group = op24 & 0xc0;
  if (group === 0x00) return (c, i) => c["armMisc"](i);
  if (group === 0x40) return (c, i) => c["armSingleTransfer"](i);
  if (group === 0x80) {
    if (op24 & 0x20) return (c, i) => c["armBranch"](i);
    return (c, i) => c["armBlockTransfer"](i);
  }
  if ((op24 & 0xf0) === 0xf0) return (c, i) => c["armSwi"](i);
  return (c, i) => c["undefined"](i);
}

for (let op24 = 0; op24 < 256; op24++) {
  ARM_TABLE[op24] = classifyArm(op24);
}

// Thumb dispatch table (256 entries indexed by bits 15-8).
// ---------------------------------------------------------------------------

const THUMB_TABLE: ThumbHandler[] = new Array(256);

for (let top = 0; top < 256; top++) {
  let handler: ThumbHandler;
  if (top < 0x18) handler = (c, i) => c["thumbShiftImm"](i);
  else if (top < 0x20) handler = (c, i) => c["thumbAddSub"](i);
  else if (top < 0x40) handler = (c, i) => c["thumbMovCmpAddSub"](i);
  else if (top < 0x44) handler = (c, i) => c["thumbAlu"](i);
  else if (top < 0x48) handler = (c, i) => c["thumbHiReg"](i);
  else if (top < 0x50) handler = (c, i) => c["thumbLdrPc"](i);
  else if (top < 0x60) handler = (c, i) => c["thumbLoadStoreReg"](i);
  else if (top < 0x80) handler = (c, i) => c["thumbLoadStoreImm"](i);
  else if (top < 0x90) handler = (c, i) => c["thumbLoadStoreHalf"](i);
  else if (top < 0xa0) handler = (c, i) => c["thumbSpRel"](i);
  else if (top < 0xb0) handler = (c, i) => c["thumbLoadAddress"](i);
  else if (top === 0xb0) handler = (c, i) => c["thumbAdjustSp"](i);
  else if (top === 0xb4 || top === 0xb5 || top === 0xbc || top === 0xbd) {
    handler = (c, i) => c["thumbPushPop"](i);
  } else if (top >= 0xc0 && top < 0xd0) handler = (c, i) => c["thumbLdmStm"](i);
  else if (top >= 0xd0 && top < 0xdf) handler = (c, i) => c["thumbCondBranch"](i);
  else if (top === 0xdf) handler = (c, i) => c["thumbSwi"](i);
  else if (top >= 0xe0 && top < 0xe8) handler = (c, i) => c["thumbBranch"](i);
  else if (top >= 0xf0 && top < 0xf8) handler = (c, i) => c["thumbBlFirst"](i);
  else if (top >= 0xf8) handler = (c, i) => c["thumbBlSecond"](i);
  else handler = (c, i) => c["undefined"](i);
  THUMB_TABLE[top] = handler;
}
