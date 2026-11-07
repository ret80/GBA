import type { CPU } from "../cpu";
import {
  FZ,
  FN,
  FH,
  FC,
  INC_FLAGS,
  DEC_FLAGS,
  LOGIC_FLAGS,
  addFlags,
  subFlags,
  addSpFlags,
} from "./flags";

/** A single decoded opcode: mnemonic (for debugging), base cycles, handler. */
export interface Op {
  mnemonic: string;
  cycles: number;
  execute: (cpu: CPU) => number;
}

type Handler = (cpu: CPU) => number;

const REG_NAMES = ["B", "C", "D", "E", "H", "L", "(HL)", "A"];

/** Read the 8-bit register selected by the low 3 bits of an opcode. */
const REG_READ: ((cpu: CPU) => number)[] = [
  (c) => c.B,
  (c) => c.C,
  (c) => c.D,
  (c) => c.E,
  (c) => c.H,
  (c) => c.L,
  (c) => c.read8(c.HL),
  (c) => c.A,
];

/** Write the 8-bit register selected by the low 3 bits of an opcode. */
const REG_WRITE: ((cpu: CPU, v: number) => void)[] = [
  (c, v) => (c.B = v & 0xff),
  (c, v) => (c.C = v & 0xff),
  (c, v) => (c.D = v & 0xff),
  (c, v) => (c.E = v & 0xff),
  (c, v) => (c.H = v & 0xff),
  (c, v) => (c.L = v & 0xff),
  (c, v) => c.write8(c.HL, v),
  (c, v) => (c.A = v & 0xff),
];

const REG16_READ: ((cpu: CPU) => number)[] = [
  (c) => c.BC,
  (c) => c.DE,
  (c) => c.HL,
  (c) => c.SP,
];

const REG16_WRITE: ((cpu: CPU, v: number) => void)[] = [
  (c, v) => (c.BC = v),
  (c, v) => (c.DE = v),
  (c, v) => (c.HL = v),
  (c, v) => (c.SP = v),
];

/** ALU operation selected by bits 5-3 of an 8-bit ALU opcode. */
const ALU: ((cpu: CPU, v: number) => void)[] = [
  // ADD
  (c, v) => {
    const r = (c.A + v) & 0xff;
    c.F = addFlags(c.A, v);
    c.A = r;
  },
  // ADC
  (c, v) => {
    const carry = c.F & FC ? 1 : 0;
    const r = (c.A + v + carry) & 0xff;
    c.F = addFlags(c.A, v, carry);
    c.A = r;
  },
  // SUB
  (c, v) => {
    const r = (c.A - v) & 0xff;
    c.F = subFlags(c.A, v);
    c.A = r;
  },
  // SBC
  (c, v) => {
    const carry = c.F & FC ? 1 : 0;
    const r = (c.A - v - carry) & 0xff;
    c.F = subFlags(c.A, v, carry);
    c.A = r;
  },
  // AND
  (c, v) => {
    c.A = c.A & v;
    c.F = LOGIC_FLAGS[c.A] | FH;
  },
  // XOR
  (c, v) => {
    c.A = c.A ^ v;
    c.F = LOGIC_FLAGS[c.A];
  },
  // OR
  (c, v) => {
    c.A = c.A | v;
    c.F = LOGIC_FLAGS[c.A];
  },
  // CP
  (c, v) => {
    c.F = subFlags(c.A, v);
  },
];

function inc8(c: CPU, v: number): number {
  const r = (v + 1) & 0xff;
  c.F = (c.F & FC) | INC_FLAGS[v];
  return r;
}

function dec8(c: CPU, v: number): number {
  const r = (v - 1) & 0xff;
  c.F = (c.F & FC) | DEC_FLAGS[v];
  return r;
}

function addHL(c: CPU, v: number): void {
  const hl = c.HL;
  const r = hl + v;
  c.F =
    (c.F & FZ) |
    ((hl & 0x0fff) + (v & 0x0fff) > 0x0fff ? FH : 0) |
    (r > 0xffff ? FC : 0);
  c.HL = r & 0xffff;
}

function daa(c: CPU): void {
  let a = c.A;
  let f = c.F;
  if (f & FN) {
    if (f & FC) a -= 0x60;
    if (f & FH) a -= 0x06;
  } else {
    if (f & FC || a > 0x99) {
      a += 0x60;
      f |= FC;
    }
    if (f & FH || (a & 0x0f) > 0x09) a += 0x06;
  }
  a &= 0xff;
  f = (f & (FN | FC)) | LOGIC_FLAGS[a];
  c.A = a;
  c.F = f;
}

const CONDITIONS: ((c: CPU) => boolean)[] = [
  (c) => (c.F & FZ) === 0, // NZ
  (c) => (c.F & FZ) !== 0, // Z
  (c) => (c.F & FC) === 0, // NC
  (c) => (c.F & FC) !== 0, // C
];

function cond(c: CPU, index: number): boolean {
  return CONDITIONS[index](c);
}

function push(c: CPU, v: number): number {
  c.push16(v);
  return 16;
}

const COND_NAMES = ["NZ", "Z", "NC", "C"];

// ---------------------------------------------------------------------------
// Build the 256-entry main page and 256-entry CB page once, at module load.
// ---------------------------------------------------------------------------

const main: Op[] = new Array(256);
const cb: Op[] = new Array(256);

function def(opcode: number, mnemonic: string, cycles: number, fn: Handler): void {
  main[opcode] = { mnemonic, cycles, execute: fn };
}

function defCB(opcode: number, mnemonic: string, cycles: number, fn: Handler): void {
  cb[opcode] = { mnemonic, cycles, execute: fn };
}

// 0x00 NOP
def(0x00, "NOP", 4, () => 4);

// 0x01-0x3F: 16-bit loads/arithmetic and 8-bit INC/DEC/LD r,d8
for (let rr = 0; rr < 4; rr++) {
  const base = rr * 0x10;
  def(base + 0x01, `LD ${["BC", "DE", "HL", "SP"][rr]},d16`, 12, (c) => {
    const v = c.read16(c.PC);
    c.PC = (c.PC + 2) & 0xffff;
    REG16_WRITE[rr](c, v);
    return 12;
  });
  def(base + 0x03, `INC ${["BC", "DE", "HL", "SP"][rr]}`, 8, (c) => {
    REG16_WRITE[rr](c, (REG16_READ[rr](c) + 1) & 0xffff);
    return 8;
  });
  def(base + 0x0b, `DEC ${["BC", "DE", "HL", "SP"][rr]}`, 8, (c) => {
    REG16_WRITE[rr](c, (REG16_READ[rr](c) - 1) & 0xffff);
    return 8;
  });
  def(base + 0x09, `ADD HL,${["BC", "DE", "HL", "SP"][rr]}`, 8, (c) => {
    addHL(c, REG16_READ[rr](c));
    return 8;
  });
}

// INC r (0x04,0x0C,...) / DEC r (0x05,0x0D,...) / LD r,d8 (0x06,0x0E,...).
// These live in the low nibble of every group, so a single loop covers them.
for (let r = 0; r < 8; r++) {
  const incOpcode = (r << 3) | 0x04;
  const decOpcode = (r << 3) | 0x05;
  const loadOpcode = (r << 3) | 0x06;
  def(incOpcode, `INC ${REG_NAMES[r]}`, r === 6 ? 12 : 4, (c) => {
    REG_WRITE[r](c, inc8(c, REG_READ[r](c)));
    return r === 6 ? 12 : 4;
  });
  def(decOpcode, `DEC ${REG_NAMES[r]}`, r === 6 ? 12 : 4, (c) => {
    REG_WRITE[r](c, dec8(c, REG_READ[r](c)));
    return r === 6 ? 12 : 4;
  });
  def(loadOpcode, `LD ${REG_NAMES[r]},d8`, r === 6 ? 12 : 8, (c) => {
    const v = c.read8(c.PC);
    c.PC = (c.PC + 1) & 0xffff;
    REG_WRITE[r](c, v);
    return r === 6 ? 12 : 8;
  });
}

// 0x02/0x0A/0x12/0x1A: LD (BC/DE),A and LD A,(BC/DE)
def(0x02, "LD (BC),A", 8, (c) => {
  c.write8(c.BC, c.A);
  return 8;
});
def(0x0a, "LD A,(BC)", 8, (c) => {
  c.A = c.read8(c.BC);
  return 8;
});
def(0x12, "LD (DE),A", 8, (c) => {
  c.write8(c.DE, c.A);
  return 8;
});
def(0x1a, "LD A,(DE)", 8, (c) => {
  c.A = c.read8(c.DE);
  return 8;
});

// 0x07/0x0F/0x17/0x1F: accumulator rotates (Z always cleared)
def(0x07, "RLCA", 4, (c) => {
  const carry = c.A >> 7;
  c.A = ((c.A << 1) | carry) & 0xff;
  c.F = carry ? FC : 0;
  return 4;
});
def(0x0f, "RRCA", 4, (c) => {
  const carry = c.A & 1;
  c.A = ((c.A >> 1) | (carry << 7)) & 0xff;
  c.F = carry ? FC : 0;
  return 4;
});
def(0x17, "RLA", 4, (c) => {
  const carry = c.A >> 7;
  c.A = ((c.A << 1) | (c.F & FC ? 1 : 0)) & 0xff;
  c.F = carry ? FC : 0;
  return 4;
});
def(0x1f, "RRA", 4, (c) => {
  const carry = c.A & 1;
  c.A = ((c.A >> 1) | (c.F & FC ? 0x80 : 0)) & 0xff;
  c.F = carry ? FC : 0;
  return 4;
});

// 0x08: LD (a16),SP
def(0x08, "LD (a16),SP", 20, (c) => {
  const addr = c.read16(c.PC);
  c.PC = (c.PC + 2) & 0xffff;
  c.write8(addr, c.SP & 0xff);
  c.write8((addr + 1) & 0xffff, (c.SP >> 8) & 0xff);
  return 20;
});

// 0x10: STOP (with CGB speed switch, see regression test)
def(0x10, "STOP", 4, (c) => {
  const mem: any = c.gb.memory;
  if (mem && (mem.key1 & 0x80)) {
    // CGB speed switch: bit7 stays set after the switch so games that poll
    // KEY1 for a completed switch keep making progress.
    mem.key1 = 0x80;
    c.doubleSpeed = !c.doubleSpeed;
    c.stopped = false;
    c.PC = (c.PC + 1) & 0xffff;
    return 4;
  }
  c.stopped = true;
  c.PC = (c.PC + 1) & 0xffff;
  return 4;
});

// 0x18: JR r8
def(0x18, "JR r8", 12, (c) => {
  const offset = (c.read8(c.PC) << 24) >> 24;
  c.PC = (c.PC + 1 + offset) & 0xffff;
  return 12;
});

// 0x20/0x28/0x30/0x38: JR cc,r8
for (let i = 0; i < 4; i++) {
  const opcode = 0x20 + i * 8;
  def(opcode, `JR ${COND_NAMES[i]},r8`, 12, (c) => {
    const offset = (c.read8(c.PC) << 24) >> 24;
    if (cond(c, i)) {
      c.PC = (c.PC + 1 + offset) & 0xffff;
      return 12;
    }
    c.PC = (c.PC + 1) & 0xffff;
    return 8;
  });
}

// 0x22/0x2A/0x32/0x3A: LD (HL+/-),A and LD A,(HL+/-)
def(0x22, "LD (HL+),A", 8, (c) => {
  c.write8(c.HL, c.A);
  c.HL = (c.HL + 1) & 0xffff;
  return 8;
});
def(0x2a, "LD A,(HL+)", 8, (c) => {
  c.A = c.read8(c.HL);
  c.HL = (c.HL + 1) & 0xffff;
  return 8;
});
def(0x32, "LD (HL-),A", 8, (c) => {
  c.write8(c.HL, c.A);
  c.HL = (c.HL - 1) & 0xffff;
  return 8;
});
def(0x3a, "LD A,(HL-)", 8, (c) => {
  c.A = c.read8(c.HL);
  c.HL = (c.HL - 1) & 0xffff;
  return 8;
});

def(0x27, "DAA", 4, (c) => {
  daa(c);
  return 4;
});
def(0x2f, "CPL", 4, (c) => {
  c.A = ~c.A & 0xff;
  c.F |= FN | FH;
  return 4;
});
def(0x37, "SCF", 4, (c) => {
  c.F = (c.F & FZ) | FC;
  return 4;
});
def(0x3f, "CCF", 4, (c) => {
  c.F = (c.F & FZ) | (c.F & FC ? 0 : FC);
  return 4;
});

// 0x00-0x3F is sparse; every remaining opcode is handled by the loops above
// except 0x10/0x18/0x20/0x22/0x27/0x2A/0x2F/0x32/0x37/0x38/0x3A/0x3F.

// 0x40-0x7F: LD r,r' (0x76 is HALT)
for (let dst = 0; dst < 8; dst++) {
  for (let src = 0; src < 8; src++) {
    const opcode = 0x40 | (dst << 3) | src;
    if (opcode === 0x76) continue;
    const cycles = dst === 6 || src === 6 ? 8 : 4;
    def(opcode, `LD ${REG_NAMES[dst]},${REG_NAMES[src]}`, cycles, (c) => {
      REG_WRITE[dst](c, REG_READ[src](c));
      return cycles;
    });
  }
}
def(0x76, "HALT", 4, (c) => {
  c.halted = true;
  return 4;
});

// 0x80-0xBF: ALU A,r
for (let kind = 0; kind < 8; kind++) {
  for (let r = 0; r < 8; r++) {
    const opcode = 0x80 | (kind << 3) | r;
    const cycles = r === 6 ? 8 : 4;
    def(opcode, `ALU${kind} ${REG_NAMES[r]}`, cycles, (c) => {
      ALU[kind](c, REG_READ[r](c));
      return cycles;
    });
  }
}

// 0xC0-0xFF: control flow, stack, immediate ALU and high-memory access.
for (let i = 0; i < 4; i++) {
  const base = 0xc0 + i * 8;

  // RET cc
  def(base, `RET ${COND_NAMES[i]}`, 20, (c) => {
    if (cond(c, i)) {
      c.PC = c.pop16();
      return 20;
    }
    return 8;
  });
  // POP rr
  def(base + 1, `POP ${["BC", "DE", "HL", "AF"][i]}`, 12, (c) => {
    const v = c.pop16();
    if (i === 3) c.AF = v;
    else REG16_WRITE[i](c, v);
    return 12;
  });
  // JP cc,a16
  def(base + 2, `JP ${COND_NAMES[i]},a16`, 16, (c) => {
    const addr = c.read16(c.PC);
    if (cond(c, i)) {
      c.PC = addr;
      return 16;
    }
    c.PC = (c.PC + 2) & 0xffff;
    return 12;
  });
  // JP a16 (0xC3)
  if (i === 0) {
    def(0xc3, "JP a16", 16, (c) => {
      c.PC = c.read16(c.PC);
      return 16;
    });
  }
  // CALL cc,a16
  def(base + 4, `CALL ${COND_NAMES[i]},a16`, 24, (c) => {
    const addr = c.read16(c.PC);
    c.PC = (c.PC + 2) & 0xffff;
    if (cond(c, i)) {
      c.push16(c.PC);
      c.PC = addr;
      return 24;
    }
    return 12;
  });
  // PUSH rr
  def(base + 5, `PUSH ${["BC", "DE", "HL", "AF"][i]}`, 16, (c) => {
    push(c, i === 3 ? c.AF : REG16_READ[i](c));
    return 16;
  });
  // ALU A,d8
  def(base + 6, `ALU${i} A,d8`, 8, (c) => {
    const v = c.read8(c.PC);
    c.PC = (c.PC + 1) & 0xffff;
    ALU[i](c, v);
    return 8;
  });
  // RST
  def(base + 7, `RST ${(i * 8).toString(16).padStart(2, "0")}h`, 16, (c) => {
    c.push16(c.PC);
    c.PC = i * 8;
    return 16;
  });
}

def(0xc9, "RET", 16, (c) => {
  c.PC = c.pop16();
  return 16;
});
def(0xcd, "CALL a16", 24, (c) => {
  const addr = c.read16(c.PC);
  c.PC = (c.PC + 2) & 0xffff;
  c.push16(c.PC);
  c.PC = addr;
  return 24;
});
def(0xd9, "RETI", 16, (c) => {
  c.PC = c.pop16();
  c.IME = true;
  return 16;
});

// 0xCB is the prefix for the second page; it is handled in CPU.step()/exec()
// before the main table is consulted, but the entry keeps the table complete.
def(0xcb, "PREFIX CB", 4, (c) => c.exec(c.read8(c.PC++)));

// Remaining 0xE0-0xFF encodings (the group loop above only covers four of
// the eight RST/ALU groups, because the upper groups share opcodes with
// dedicated instructions).
def(0xe1, "POP HL", 12, (c) => {
  c.HL = c.pop16();
  return 12;
});
def(0xe5, "PUSH HL", 16, (c) => {
  c.push16(c.HL);
  return 16;
});
def(0xe7, "RST 20h", 16, (c) => {
  c.push16(c.PC);
  c.PC = 0x20;
  return 16;
});
def(0xe6, "AND d8", 8, (c) => {
  ALU[4](c, c.read8(c.PC++));
  return 8;
});
def(0xee, "XOR d8", 8, (c) => {
  ALU[5](c, c.read8(c.PC++));
  return 8;
});
def(0xef, "RST 28h", 16, (c) => {
  c.push16(c.PC);
  c.PC = 0x28;
  return 16;
});
def(0xf6, "OR d8", 8, (c) => {
  ALU[6](c, c.read8(c.PC++));
  return 8;
});
def(0xf7, "RST 30h", 16, (c) => {
  c.push16(c.PC);
  c.PC = 0x30;
  return 16;
});
def(0xfe, "CP d8", 8, (c) => {
  ALU[7](c, c.read8(c.PC++));
  return 8;
});
def(0xff, "RST 38h", 16, (c) => {
  c.push16(c.PC);
  c.PC = 0x38;
  return 16;
});

def(0xe0, "LDH (a8),A", 12, (c) => {
  const addr = 0xff00 + c.read8(c.PC);
  c.PC = (c.PC + 1) & 0xffff;
  c.write8(addr, c.A);
  return 12;
});
def(0xe2, "LD (C),A", 8, (c) => {
  c.write8(0xff00 + c.C, c.A);
  return 8;
});
def(0xe8, "ADD SP,r8", 16, (c) => {
  const e8 = (c.read8(c.PC) << 24) >> 24;
  c.PC = (c.PC + 1) & 0xffff;
  c.F = addSpFlags(c.SP, e8);
  c.SP = (c.SP + e8) & 0xffff;
  return 16;
});
def(0xe9, "JP HL", 4, (c) => {
  c.PC = c.HL;
  return 4;
});
def(0xea, "LD (a16),A", 16, (c) => {
  const addr = c.read16(c.PC);
  c.PC = (c.PC + 2) & 0xffff;
  c.write8(addr, c.A);
  return 16;
});
def(0xf0, "LDH A,(a8)", 12, (c) => {
  const addr = 0xff00 + c.read8(c.PC);
  c.PC = (c.PC + 1) & 0xffff;
  c.A = c.read8(addr);
  return 12;
});
def(0xf1, "POP AF", 12, (c) => {
  c.AF = c.pop16();
  return 12;
});
def(0xf2, "LD A,(C)", 8, (c) => {
  c.A = c.read8(0xff00 + c.C);
  return 8;
});
def(0xf3, "DI", 4, (c) => {
  c.IME = false;
  c.IMEEnabled = false;
  return 4;
});
def(0xf5, "PUSH AF", 16, (c) => {
  c.push16(c.AF);
  return 16;
});
def(0xf8, "LD HL,SP+r8", 12, (c) => {
  const e8 = (c.read8(c.PC) << 24) >> 24;
  c.PC = (c.PC + 1) & 0xffff;
  c.F = addSpFlags(c.SP, e8);
  c.HL = (c.SP + e8) & 0xffff;
  return 12;
});
def(0xf9, "LD SP,HL", 8, (c) => {
  c.SP = c.HL;
  return 8;
});
def(0xfa, "LD A,(a16)", 16, (c) => {
  const addr = c.read16(c.PC);
  c.PC = (c.PC + 2) & 0xffff;
  c.A = c.read8(addr);
  return 16;
});
def(0xfb, "EI", 4, (c) => {
  c.IMEEnabled = true;
  return 4;
});

// Illegal / unimplemented opcodes are 4-cycle no-ops (as on real hardware for
// the documented illegal encodings, which lock up the CPU).
const illegal = (opcode: number): void => {
  main[opcode] ??= {
    mnemonic: `DB ${opcode.toString(16).padStart(2, "0")}`,
    cycles: 4,
    execute: () => 4,
  };
};
for (let opcode = 0; opcode < 256; opcode++) illegal(opcode);

// ---------------------------------------------------------------------------
// 0xCB page: rotates/shifts (0x00-0x3F), BIT (0x40-0x7F), RES (0x80-0xBF),
// SET (0xC0-0xFF).
// ---------------------------------------------------------------------------

type CBOperation = (cpu: CPU, value: number) => number;

const RLC: CBOperation = (c, v) => {
  const carry = v >> 7;
  const r = ((v << 1) | carry) & 0xff;
  c.F = LOGIC_FLAGS[r] | (carry ? FC : 0);
  return r;
};
const RRC: CBOperation = (c, v) => {
  const carry = v & 1;
  const r = ((v >> 1) | (carry << 7)) & 0xff;
  c.F = LOGIC_FLAGS[r] | (carry ? FC : 0);
  return r;
};
const RL: CBOperation = (c, v) => {
  const carry = v >> 7;
  const r = ((v << 1) | (c.F & FC ? 1 : 0)) & 0xff;
  c.F = LOGIC_FLAGS[r] | (carry ? FC : 0);
  return r;
};
const RR: CBOperation = (c, v) => {
  const carry = v & 1;
  const r = ((v >> 1) | (c.F & FC ? 0x80 : 0)) & 0xff;
  c.F = LOGIC_FLAGS[r] | (carry ? FC : 0);
  return r;
};
const SLA: CBOperation = (c, v) => {
  const carry = v >> 7;
  const r = (v << 1) & 0xff;
  c.F = LOGIC_FLAGS[r] | (carry ? FC : 0);
  return r;
};
const SRA: CBOperation = (c, v) => {
  const carry = v & 1;
  const r = ((v >> 1) | (v & 0x80)) & 0xff;
  c.F = LOGIC_FLAGS[r] | (carry ? FC : 0);
  return r;
};
const SWAP: CBOperation = (c, v) => {
  const r = (((v & 0x0f) << 4) | ((v >> 4) & 0x0f)) & 0xff;
  c.F = LOGIC_FLAGS[r];
  return r;
};
const SRL: CBOperation = (c, v) => {
  const carry = v & 1;
  const r = (v >> 1) & 0xff;
  c.F = LOGIC_FLAGS[r] | (carry ? FC : 0);
  return r;
};

const CB_SHIFT: CBOperation[] = [RLC, RRC, RL, RR, SLA, SRA, SWAP, SRL];
const CB_SHIFT_NAMES = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SWAP", "SRL"];

for (let group = 0; group < 4; group++) {
  for (let bit = 0; bit < 8; bit++) {
    for (let r = 0; r < 8; r++) {
      const opcode = (group << 6) | (bit << 3) | r;
      const target = REG_NAMES[r];
      const isMem = r === 6;

      if (group === 0) {
        // Rotate/shift: 8 cycles (16 when operating on (HL)).
        const cycles = isMem ? 16 : 8;
        const shift = CB_SHIFT[bit];
        defCB(opcode, `${CB_SHIFT_NAMES[bit]} ${target}`, cycles, (c) => {
          REG_WRITE[r](c, shift(c, REG_READ[r](c)));
          return cycles;
        });
      } else if (group === 1) {
        // BIT: 8 cycles (12 with (HL)); Z=bit clear, N=0, H=1, C untouched.
        const cycles = isMem ? 12 : 8;
        defCB(opcode, `BIT ${bit},${target}`, cycles, (c) => {
          const v = REG_READ[r](c);
          c.F = (c.F & FC) | FH | (v & (1 << bit) ? 0 : FZ);
          return cycles;
        });
      } else {
        // RES/SET: 8 cycles (16 with (HL)).
        const cycles = isMem ? 16 : 8;
        const mask = 1 << bit;
        const set = group === 3;
        defCB(opcode, `${set ? "SET" : "RES"} ${bit},${target}`, cycles, (c) => {
          const v = REG_READ[r](c);
          REG_WRITE[r](c, set ? v | mask : v & ~mask);
          return cycles;
        });
      }
    }
  }
}

export const MAIN_OPS: readonly Op[] = main;
export const CB_OPS: readonly Op[] = cb;
