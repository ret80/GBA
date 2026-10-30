export class Timer {
  private gb: any;
  public DIV: number = 0; // 0xFF04
  public TIMA: number = 0; // 0xFF05
  public TMA: number = 0; // 0xFF06
  public TAC: number = 0; // 0xFF07

  private divCounter: number = 0;
  private timaCounter: number = 0;

  constructor(gb: any) {
    this.gb = gb;
  }

  step(cycles: number): void {
    this.divCounter += cycles;
    while (this.divCounter >= 256) {
      this.divCounter -= 256;
      this.DIV = (this.DIV + 1) & 0xFF;
    }

    if (!(this.TAC & 0x04)) return; // Timer disabled

    const clockSelect = this.TAC & 0x03;
    let threshold = 0;
    switch (clockSelect) {
      case 0: threshold = 1024; break;
      case 1: threshold = 16; break;
      case 2: threshold = 64; break;
      case 3: threshold = 256; break;
    }

    this.timaCounter += cycles;
    while (this.timaCounter >= threshold) {
      this.timaCounter -= threshold;
      this.TIMA++;
      if (this.TIMA > 0xFF) {
        this.TIMA = this.TMA;
        if (this.gb.interrupts) {
          this.gb.interrupts.request(0x04); // Timer interrupt
        }
      }
    }
  }

  reset(): void {
    this.DIV = 0;
    this.TIMA = 0;
    this.TMA = 0;
    this.TAC = 0;
    this.divCounter = 0;
    this.timaCounter = 0;
  }

  getState(): Uint8Array {
    const state = new Uint8Array(13);
    const view = new DataView(state.buffer);
    view.setUint8(0, this.DIV);
    view.setUint8(1, this.TIMA);
    view.setUint8(2, this.TMA);
    view.setUint8(3, this.TAC);
    view.setUint32(4, this.divCounter, true);
    view.setUint32(8, this.timaCounter, true);
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 13) throw new Error("Invalid Timer state");
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    this.DIV = view.getUint8(0);
    this.TIMA = view.getUint8(1);
    this.TMA = view.getUint8(2);
    this.TAC = view.getUint8(3);
    this.divCounter = view.getUint32(4, true);
    this.timaCounter = view.getUint32(8, true);
  }
}
