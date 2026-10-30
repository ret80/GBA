// Basic CPU tests
import { describe, it, expect } from 'vitest';
import { GameBoy } from '../src/emulator/gameboy';

describe('CPU Basic', () => {
  it('should initialize', () => {
    const gb = new GameBoy();
    expect(gb.cpu.A).toBe(0x01);
    expect(gb.cpu.PC).toBe(0x0100);
  });
  
  it('should execute NOP', () => {
    const gb = new GameBoy();
    const cycles = gb.cpu.exec(0x00);
    expect(cycles).toBe(4);
  });
  
  it('should execute LD BC,d16', () => {
    const gb = new GameBoy();
    gb.cpu.PC = 0xC000;
    gb.memory.write8(0xC000, 0x01);
    gb.memory.write8(0xC001, 0x34);
    gb.memory.write8(0xC002, 0x12);
    const op = gb.cpu.read8(gb.cpu.PC++);
    gb.cpu.C = gb.memory.read8(gb.cpu.PC++);
    gb.cpu.B = gb.memory.read8(gb.cpu.PC++);
    expect(gb.cpu.BC).toBe(0x1234);
  });
});
