import { describe, it, expect } from 'vitest';
import { GameBoy } from '../src/emulator/gameboy';

function makeRom(ramEnabled = false): Uint8Array {
  const rom = new Uint8Array(0x8000);
  // Title
  for (let i = 0; i < 16; i++) rom[0x134 + i] = 0x41 + i;
  // GB, MBC1 with RAM (0x03), ROM 32KB, RAM 32KB
  rom[0x147] = 0x03;
  rom[0x148] = 0x00;
  rom[0x149] = 0x03;
  return rom;
}

describe('Save state', () => {
  it('round-trips CPU and memory state', () => {
    const gb = new GameBoy();
    gb.loadRom(makeRom());
    gb.cpu.A = 0x42;
    gb.cpu.B = 0x24;
    gb.cpu.PC = 0xC123;
    gb.cpu.IME = true;
    gb.memory.write8(0xC000, 0xFA);
    gb.memory.write8(0xD000, 0xFB);
    gb.timer.TIMA = 0x77;
    gb.ppu.LY = 3;

    const save = gb.saveState();
    expect(save.length).toBeGreaterThan(1000);

    gb.cpu.A = 0x00;
    gb.cpu.B = 0x00;
    gb.cpu.PC = 0;
    gb.cpu.IME = false;
    gb.memory.write8(0xC000, 0x00);
    gb.memory.write8(0xD000, 0x00);
    gb.timer.TIMA = 0;
    gb.ppu.LY = 0;

    gb.loadState(save);

    expect(gb.cpu.A).toBe(0x42);
    expect(gb.cpu.B).toBe(0x24);
    expect(gb.cpu.PC).toBe(0xC123);
    expect(gb.cpu.IME).toBe(true);
    expect(gb.memory.read8(0xC000)).toBe(0xFA);
    expect(gb.memory.read8(0xD000)).toBe(0xFB);
    expect(gb.timer.TIMA).toBe(0x77);
    expect(gb.ppu.LY).toBe(3);
  });

  it('round-trips cartridge RAM and MBC state', () => {
    const gb = new GameBoy();
    gb.loadRom(makeRom());
    gb.cartridge.ramEnabled = true;
    gb.cartridge.bankingMode = 1;
    gb.cartridge.ramBank = 0;
    gb.cartridge.writeRam(0, 0xAA);
    gb.cartridge.ramBank = 1;
    gb.cartridge.writeRam(0, 0xBB);
    gb.cartridge.ramBank = 2;
    gb.cartridge.writeRam(0, 0xCC);
    gb.cartridge.romBank = 0x21;

    const save = gb.saveState();
    gb.cartridge.ramEnabled = false;
    gb.cartridge.ramBank = 0;
    gb.cartridge.romBank = 1;
    gb.cartridge.bankingMode = 0;

    gb.loadState(save);

    expect(gb.cartridge.ramEnabled).toBe(true);
    expect(gb.cartridge.ramBank).toBe(2);
    expect(gb.cartridge.romBank).toBe(0x21);
    expect(gb.cartridge.bankingMode).toBe(1);
    expect(gb.cartridge.readRam(0)).toBe(0xCC);
    gb.cartridge.ramBank = 1;
    expect(gb.cartridge.readRam(0)).toBe(0xBB);
    gb.cartridge.ramBank = 0;
    expect(gb.cartridge.readRam(0)).toBe(0xAA);
  });

  it('rejects a save from a different ROM', () => {
    const gb = new GameBoy();
    gb.loadRom(makeRom());
    const save = gb.saveState();

    const gb2 = new GameBoy();
    gb2.loadRom(makeRom());
    const bigger = new Uint8Array(0x8000 * 2);
    bigger.set(makeRom().subarray(0, 0x8000));
    bigger[0x147] = 0x03;
    bigger[0x148] = 0x01;
    bigger[0x149] = 0x03;
    gb2.cartridge.rom = bigger;
    gb2.cartridge.load(bigger);

    expect(() => gb2.loadState(save)).toThrow(/different ROM/);
  });

  it('stores game title and rejects checksum mismatch for same-size ROM', () => {
    const gb = new GameBoy();
    gb.loadRom(makeRom());
    const save = gb.saveState();
    // ROM title is "ABCDEFGHIJKLMNOP" (set by makeRom)
    const raw = Buffer.from(save, 'base64');
    expect(raw[7]).toBe(2); // version 2
    // header: magic(7) ver(1) reserved(1) titleLen(1) title...
    const titleLen = raw[9];
    const title = raw.subarray(10, 10 + titleLen).toString('latin1');
    expect(title).toBe('ABCDEFGHIJKLMNOP');

    // Different ROM of the same size, different byte -> CRC must catch it
    const other = makeRom();
    other[0x100] = 0xAA;
    const gb2 = new GameBoy();
    gb2.loadRom(other);
    expect(() => gb2.loadState(save)).toThrow(/checksum mismatch/);
  });

  it('loads legacy v1 save states (no ROM id)', () => {
    const gb = new GameBoy();
    gb.loadRom(makeRom());
    gb.cpu.A = 0x99;
    const v2 = gb.saveState();
    const raw = Buffer.from(v2, 'base64');
    // Build a v1 file from the v2 parts (version byte only + no extended header)
    const titleLen = raw[9];
    const partsStart = 10 + titleLen + 9; // after title + romSize + crc + partsCount
    const partsEnd = raw.length;
    const parts = raw.subarray(partsStart, partsEnd);
    const v1 = Buffer.concat([
      Buffer.from('GBSTATE\x01\x00', 'latin1'),
      parts,
    ]);
    const gb2 = new GameBoy();
    gb2.loadRom(makeRom());
    gb2.loadState(v1.toString('base64'));
    expect(gb2.cpu.A).toBe(0x99);
  });
});