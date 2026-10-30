export type Byte = number;
export type Word = number;

export interface GameBoyColor {
  cpu: any;
  memory: any;
  ppu: any;
  apu: any;
  timer: any;
  interrupts: any;
  joypad: any;
  cartridge: any;
  runFrame(): void;
  reset(): void;
  loadRom(rom: Uint8Array): void;
}

export const InterruptType = {
  VBlank: 0x01,
  LCD_STAT: 0x02,
  Timer: 0x04,
  Serial: 0x08,
  Joypad: 0x10,
} as const;
export type InterruptType = typeof InterruptType[keyof typeof InterruptType];
