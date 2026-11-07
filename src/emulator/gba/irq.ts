export const IRQ_VBLANK = 0;
export const IRQ_HBLANK = 1;
export const IRQ_VCOUNT = 2;
export const IRQ_TIMER0 = 3;
export const IRQ_SERIAL = 7;
export const IRQ_DMA0 = 8;
export const IRQ_KEYPAD = 12;
export const IRQ_GAMEPAK = 13;

/** GBA interrupt controller (IE / IF / IME). */
export class GbaIrq {
  public ie = 0;
  public if_ = 0;
  public ime = 0;

  request(bit: number): void {
    this.if_ |= 1 << bit;
  }

  /** Interrupts requested and enabled (ignores IME; used to wake HALT). */
  get requested(): number {
    return this.ie & this.if_;
  }

  get pending(): boolean {
    return this.ime !== 0 && (this.ie & this.if_) !== 0;
  }

  /** BIOS acknowledges every enabled request before calling the handler. */
  acknowledge(): void {
    this.if_ &= ~(this.ie & this.if_);
  }

  reset(): void {
    this.ie = 0;
    this.if_ = 0;
    this.ime = 0;
  }
}
