import { IRQ_TIMER0 } from "./irq";

interface TimerChannel {
  counter: number;
  reload: number;
  control: number;
  fraction: number;
  enabled: boolean;
  lastOverflow: boolean;
}

const PRESCALERS = [1, 64, 256, 1024];

/**
 * Four GBA timers. Each channel counts up at 16.78 MHz / prescaler and
 * requests an IRQ on overflow; cascade mode clocks a channel from the
 * previous channel's overflow instead of the CPU clock.
 */
export class GbaTimers {
  public channels: TimerChannel[] = Array.from({ length: 4 }, () => ({
    counter: 0,
    reload: 0,
    control: 0,
    fraction: 0,
    enabled: false,
    lastOverflow: false,
  }));

  private readonly machine: any;

  constructor(machine: any) {
    this.machine = machine;
  }

  reset(): void {
    for (const ch of this.channels) {
      ch.counter = 0;
      ch.reload = 0;
      ch.control = 0;
      ch.fraction = 0;
      ch.enabled = false;
      ch.lastOverflow = false;
    }
  }

  readIO(off: number): number {
    const channel = (off - 0x100) >> 2;
    if (off & 2) return this.channels[channel].control;
    return this.channels[channel].counter & 0xffff;
  }

  writeIO(off: number, value: number): void {
    const channel = (off - 0x100) >> 2;
    const ch = this.channels[channel];
    if (off & 2) {
      const wasEnabled = ch.enabled;
      ch.control = value & 0xffff;
      ch.enabled = (value & 0x80) !== 0;
      if (ch.enabled && !wasEnabled) {
        ch.counter = ch.reload;
        ch.fraction = 0;
      }
    } else {
      ch.reload = value & 0xffff;
    }
  }

  step(cycles: number): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.channels[i];
      if (!ch.enabled) continue;
      if (ch.control & 0x4) {
        // Cascade: clocked by the previous timer's overflow.
        continue;
      }
      ch.fraction += cycles;
      const prescaler = PRESCALERS[ch.control & 0x3];
      while (ch.fraction >= prescaler) {
        ch.fraction -= prescaler;
        this.tick(i);
      }
    }
  }

  private tick(index: number): void {
    const ch = this.channels[index];
    ch.counter++;
    if (ch.counter > 0xffff) {
      ch.counter = ch.reload;
      this.onOverflow(index);
    }
  }

  private onOverflow(index: number): void {
    const ch = this.channels[index];
    if (ch.control & 0x40) this.machine.requestIrq(IRQ_TIMER0 + index);
    const next = this.channels[index + 1];
    if (next && next.enabled && next.control & 0x4) this.tick(index + 1);
  }

  getState(): number[] {
    const out: number[] = [];
    for (const ch of this.channels) {
      out.push(ch.counter, ch.reload, ch.control, ch.fraction, ch.enabled ? 1 : 0);
    }
    return out;
  }

  setState(state: number[]): void {
    for (let i = 0; i < 4; i++) {
      const ch = this.channels[i];
      const base = i * 5;
      ch.counter = state[base] ?? 0;
      ch.reload = state[base + 1] ?? 0;
      ch.control = state[base + 2] ?? 0;
      ch.fraction = state[base + 3] ?? 0;
      ch.enabled = (state[base + 4] ?? 0) !== 0;
    }
  }
}
