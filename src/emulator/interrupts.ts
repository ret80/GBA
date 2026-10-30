import { InterruptType } from "./types";

export class Interrupts {
  public IE: number = 0xE1; // Interrupt Enable (0xFFFF)
  public IF: number = 0xE1; // Interrupt Flag (0xFF0F)

  constructor(_gb: any) {}

  request(type: InterruptType): void {
    this.IF |= type;
  }

  getPending(): number {
    return this.IE & this.IF;
  }

  clear(type: InterruptType): void {
    this.IF &= ~type;
  }

  reset(): void {
    this.IE = 0xE1;
    this.IF = 0xE1;
  }

  getState(): Uint8Array {
    const state = new Uint8Array(2);
    state[0] = this.IE;
    state[1] = this.IF;
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 2) throw new Error("Invalid Interrupts state");
    this.IE = state[0];
    this.IF = state[1];
  }
}
