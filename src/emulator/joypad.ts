export class Joypad {
  private gb: any;
  public P1: number = 0xCF; // 0xFF00

  private buttons: number = 0x0F;
  private dpad: number = 0x0F;

  constructor(gb: any) {
    this.gb = gb;
  }

  setButton(button: number, pressed: boolean): void {
    if (pressed) {
      if (button < 4) {
        // D-pad
        const bit = button;
        const wasHigh = (this.dpad & (1 << bit)) !== 0;
        this.dpad &= ~(1 << bit);
        if (wasHigh && this.isDpadSelected() && this.gb.interrupts) {
          this.gb.interrupts.request(0x10); // Joypad interrupt
        }
      } else {
        // Buttons
        const bit = button - 4;
        const wasHigh = (this.buttons & (1 << bit)) !== 0;
        this.buttons &= ~(1 << bit);
        if (wasHigh && this.isButtonSelected() && this.gb.interrupts) {
          this.gb.interrupts.request(0x10);
        }
      }
    } else {
      if (button < 4) {
        this.dpad |= (1 << button);
      } else {
        this.buttons |= (1 << (button - 4));
      }
    }
    this.updateP1();
  }

  private isDpadSelected(): boolean {
    return (this.P1 & 0x10) === 0;
  }

  private isButtonSelected(): boolean {
    return (this.P1 & 0x20) === 0;
  }

  updateP1(): void {
    let result = this.P1 & 0x30;
    if (this.isDpadSelected()) {
      result |= this.dpad;
    }
    if (this.isButtonSelected()) {
      result |= this.buttons;
    }
    if (!this.isDpadSelected() && !this.isButtonSelected()) {
      result |= 0x0F;
    }
    this.P1 = result | 0xC0;
  }

  read(): number {
    this.updateP1();
    return this.P1;
  }

  // P1 write selects which button group(s) are readable. If the game switches
  // a group into the readable state while one of its buttons is already held
  // down, real hardware sees a falling edge and fires the joypad interrupt.
  // Add that edge here (the press-time edge is handled in setButton).
  write(value: number): void {
    const old = this.P1;
    this.P1 = (this.P1 & 0xCF) | (value & 0x30);
    this.updateP1();
    if (!this.gb || !this.gb.interrupts) return;

    const dpadNowSel = (this.P1 & 0x10) === 0;
    const btnNowSel = (this.P1 & 0x20) === 0;
    const dpadWasSel = (old & 0x10) === 0;
    const btnWasSel = (old & 0x20) === 0;

    // A group became readable and it currently has a held (pressed) button.
    if ((!dpadWasSel && dpadNowSel) && (this.dpad & 0x0F) !== 0x0F) {
      this.gb.interrupts.request(0x10);
    }
    if ((!btnWasSel && btnNowSel) && (this.buttons & 0x0F) !== 0x0F) {
      this.gb.interrupts.request(0x10);
    }
  }

  reset(): void {
    this.P1 = 0xCF;
    this.buttons = 0x0F;
    this.dpad = 0x0F;
  }

  getState(): Uint8Array {
    const state = new Uint8Array(3);
    state[0] = this.P1;
    state[1] = this.buttons;
    state[2] = this.dpad;
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 3) throw new Error("Invalid Joypad state");
    this.P1 = state[0];
    this.buttons = state[1];
    this.dpad = state[2];
    this.updateP1();
  }
}