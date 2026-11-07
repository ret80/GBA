import { IRQ_KEYPAD } from "./irq";

export const GBA_BUTTONS = {
  A: 0,
  B: 1,
  SELECT: 2,
  START: 3,
  RIGHT: 4,
  LEFT: 5,
  UP: 6,
  DOWN: 7,
  R: 8,
  L: 9,
} as const;

/** GBA keypad: KEYINPUT is active low, KEYCNT can raise an IRQ. */
export class GbaKeypad {
  public keycnt = 0;
  private pressed = 0; // bit set = pressed (active high internally)

  private readonly machine: any;

  constructor(machine: any) {
    this.machine = machine;
  }

  setButton(button: number, down: boolean): void {
    const before = this.pressed;
    if (down) this.pressed |= 1 << button;
    else this.pressed &= ~(1 << button);
    if (!down || this.keycnt === 0) return;
    if (!(this.keycnt & 0x4000)) return;

    const mask = this.keycnt & 0x3ff;
    const andMode = (this.keycnt & 0x8000) !== 0;
    const matches = andMode
      ? (this.pressed & mask) === mask
      : (this.pressed & mask) !== 0;
    const matchedBefore = andMode
      ? (before & mask) === mask
      : (before & mask) !== 0;
    if (matches && !matchedBefore) this.machine.requestIrq(IRQ_KEYPAD);
  }

  readKeyInput(): number {
    return (~this.pressed) & 0x3ff;
  }

  releaseAll(): void {
    this.pressed = 0;
  }

  reset(): void {
    this.pressed = 0;
    this.keycnt = 0;
  }
}
