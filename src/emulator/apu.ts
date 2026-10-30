// Game Boy / CGB APU (audio processing unit).
//
// Generates real stereo PCM samples across the four sound channels (two pulse
// channels, one programmable wave channel, one noise channel), with frame
// sequencer (length counters, volume envelopes, frequency sweep), the DAC
// power registers, per-channel panning (NR51) and master volume (NR50).
//
// The emulator advances the APU by CPU cycles (in the 4.194 MHz "T-cycle"
// domain, i.e. after the double-speed halving done in GameBoy.runFrame). The
// APU converts those cycles into samples at `sampleRate` Hz and exposes them
// via readSamples() as interleaved Float32 [L,R,L,R,...]. The browser host
// (main.ts) pulls them into the Web Audio graph.

const CLOCK_HZ = 4194304; // APU/timer clock (4.194304 MHz)
const FRAME_SEQ_CYCLES = 8192; // 1/512 s frame sequencer step
const MAX_LENGTH = 64; // 64 length units (256 intervals at 256 Hz... addressed below)

// Pulse-channel duty patterns (8 steps). Each element = 1 for "high".
const DUTY_TABLE: number[][] = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
  [1, 0, 0, 0, 0, 0, 0, 1], // 25%
  [1, 0, 0, 0, 0, 1, 1, 1], // 50%
  [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];

// Noise divisor periods (in APU clock cycles) indexed by the low 3 bits of NR43.
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

// One-pole smoothing / DC-block coefficients for the final mix. The APU clock
// (CLOCK_HZ) is twice the 2.097 MHz PSG clock, so every PSG-derived period is
// doubled below. The LPF gently rolls off hard square/noise edges (anti-alias:
// ~6 kHz corner at 44.1 kHz) and the DC blocker removes the constant bias the
// unipolar GB mix carries (AC-coupling equivalent, ~35 Hz corner).
const LPF_A = 0.87; // y += A*(x-y); A→1 = bright, A→0 = heavily smoothed
const DC_R = 0.995; // y = x - x[n-1] + R*y[n-1]; removes DC below ~35 Hz

interface ChannelState {
  enabled: boolean;
  dacOn: boolean;
  active: boolean; // currently sounding (after trigger, length > 0)
  freq: number; // 11-bit frequency value
  phase: number; // waveform phase accumulator (cycles)
  duty: number; // pulse duty index (0-3)
  volume: number; // envelope volume (0-15)
  envDir: number; // +1 / -1
  envPeriod: number; // 0-7
  envTimer: number;
  length: number; // remaining length units
  lengthEnable: boolean; // bit 6 of NRx4
  sweepPeriod: number;
  sweepDir: number;
  sweepShift: number;
  sweepTimer: number;
  sweepEnabled: boolean;
  lfsr: number;
  noiseT: number;
}

export class APU {
  // Sound registers (public so memory.ts readIO / save-load keep working).
  public NR10: number = 0x80;
  public NR11: number = 0xBF;
  public NR12: number = 0xF3;
  public NR13: number = 0xFF;
  public NR14: number = 0xBF;

  public NR21: number = 0x3F;
  public NR22: number = 0x00;
  public NR23: number = 0xFF;
  public NR24: number = 0xBF;

  public NR30: number = 0x7F;
  public NR31: number = 0xFF;
  public NR32: number = 0x9F;
  public NR33: number = 0xFF;
  public NR34: number = 0xBF;

  public NR41: number = 0xFF;
  public NR42: number = 0x00;
  public NR43: number = 0x00;
  public NR44: number = 0xBF;

  public NR50: number = 0x77;
  public NR51: number = 0xF3;
  public NR52: number = 0xF1;

  public waveRam: Uint8Array = new Uint8Array(16);

  public sampleRate: number = 44100;

  private frameSequencer: number = 0; // 0-7 step index
  private frameSequencerCounter: number = 0; // cycles to next step
  private clockCounter: number = 0; // cycles to next sample

  private ch: ChannelState[] = [
    this.makeChannel(), // channel 1 (pulse + sweep)
    this.makeChannel(), // channel 2 (pulse)
    this.makeChannel(), // channel 3 (wave)
    this.makeChannel(), // channel 4 (noise)
  ];

  private sampleBuffer: number[] = []; // interleaved L,R

  // One-pole DC-blocker + low-pass state for each output side.
  private dcPrevXL = 0; private dcPrevYL = 0; private lpYL = 0;
  private dcPrevXR = 0; private dcPrevYR = 0; private lpYR = 0;

  constructor(_gb: any) {
    this.reloadCycle();
  }

  private makeChannel(): ChannelState {
    return {
      enabled: false, dacOn: false, active: false, freq: 0, phase: 0,
      duty: 2, volume: 0, envDir: 1, envPeriod: 0, envTimer: 0,
      length: 0, lengthEnable: false, sweepPeriod: 0, sweepDir: 0, sweepShift: 0,
      sweepTimer: 0, sweepEnabled: false, lfsr: 0x7FFF, noiseT: 0,
    };
  }

  private reloadCycle(): void {
    this.clockCounter = 0;
  }

  // ---- register writes ----------------------------------------------------

  writeRegister(addr: number, value: number): void {
    value &= 0xFF;
    switch (addr) {
      case 0xFF10: this.NR10 = value; this.onSweepReg(); return;
      case 0xFF11: this.NR11 = value; this.onLengthDuty(0, value); return;
      case 0xFF12: this.NR12 = value; this.onEnvelopeDac(0, value); return;
      case 0xFF13: this.NR13 = value; return;
      case 0xFF14: this.NR14 = value; this.onFreqHigh(0, value); if (value & 0x80) this.triggerChannel(0); return;
      case 0xFF16: this.NR21 = value; this.onLengthDuty(1, value); return;
      case 0xFF17: this.NR22 = value; this.onEnvelopeDac(1, value); return;
      case 0xFF18: this.NR23 = value; return;
      case 0xFF19: this.NR24 = value; this.onFreqHigh(1, value); if (value & 0x80) this.triggerChannel(1); return;
      case 0xFF1A: this.NR30 = value; this.onWaveDac(value); return;
      case 0xFF1B: this.NR31 = value; this.ch[2].length = 256 - value; return;
      case 0xFF1C: this.NR32 = value; return;
      case 0xFF1D: this.NR33 = value; return;
      case 0xFF1E: this.NR34 = value; this.onFreqHigh(2, value); if (value & 0x80) this.triggerChannel(2); return;
      case 0xFF20: this.NR41 = value; this.ch[3].length = 64 - (value & 0x3F); return;
      case 0xFF21: this.NR42 = value; this.onEnvelopeDac(3, value); return;
      case 0xFF22: this.NR43 = value; this.ch[3].active = true; return;
      case 0xFF23: this.NR44 = value; this.ch[3].lengthEnable = (value & 0x40) !== 0; if (value & 0x80) this.triggerChannel(3); return;
      case 0xFF24: this.NR50 = value; return;
      case 0xFF25: this.NR51 = value; return;
      case 0xFF26: this.NR52 = (this.NR52 & 0x7F) | value; if (!(value & 0x80)) this.powerOff(); return;
    }
  }

  private onSweepReg(): void {
    const ch = this.ch[0];
    ch.sweepPeriod = (this.NR10 >> 4) & 0x07;
    ch.sweepDir = (this.NR10 & 0x08) ? -1 : 1;
    ch.sweepShift = this.NR10 & 0x07;
    ch.sweepEnabled = false;
  }

  private onLengthDuty(idx: number, value: number): void {
    const ch = this.ch[idx];
    ch.duty = (value >> 6) & 0x03;
    ch.length = MAX_LENGTH - (value & 0x3F);
  }

  private onEnvelopeDac(idx: number, value: number): void {
    const ch = this.ch[idx];
    ch.dacOn = (value & 0x80) !== 0;
    ch.volume = (value >> 4) & 0x0F;
    ch.envDir = (value & 0x08) ? 1 : -1;
    ch.envPeriod = value & 0x07;
    if (!ch.dacOn) { ch.active = false; this.updateNR52(); }
  }

  private onWaveDac(value: number): void {
    const ch = this.ch[2];
    ch.dacOn = (value & 0x80) !== 0;
    if (!ch.dacOn) { ch.active = false; this.updateNR52(); }
  }

  private onFreqHigh(idx: number, value: number): void {
    const ch = this.ch[idx];
    ch.lengthEnable = (value & 0x40) !== 0;
    ch.freq = ((value & 0x07) << 8) | (idx < 3 ? this.getFreqLow(idx) : 0);
    if (idx === 0 && ch.sweepEnabled) this.runSweep();
  }

  private getFreqLow(idx: number): number {
    if (idx === 0) return this.NR13;
    if (idx === 1) return this.NR23;
    if (idx === 2) return this.NR33;
    return 0;
  }

  private triggerChannel(idx: number): void {
    const ch = this.ch[idx];
    if (idx < 2) {
      ch.phase = 0;
      ch.length = MAX_LENGTH - (idx === 0 ? (this.NR11 & 0x3F) : (this.NR21 & 0x3F));
      this.onEnvelopeDac(idx, idx === 0 ? this.NR12 : this.NR22);
      ch.envTimer = ch.envPeriod;
      if (idx === 0) {
        ch.sweepEnabled = ch.sweepShift !== 0;
        ch.sweepTimer = ch.sweepPeriod || 8;
        this.sweepCalc(ch);
      }
    } else if (idx === 2) {
      ch.phase = 0;
      ch.length = 256 - this.NR31;
    } else if (idx === 3) {
      ch.length = 64 - (this.NR41 & 0x3F);
      ch.lfsr = 0x7FFF;
      ch.noiseT = 0;
      this.onEnvelopeDac(3, this.NR42);
      ch.envTimer = ch.envPeriod;
    }
    ch.active = ch.dacOn && ch.length > 0;
    this.updateNR52();
  }

  private sweepCalc(ch: ChannelState): void {
    if (ch.sweepShift === 0) return;
    const newFreq = ch.freq + ch.sweepDir * (ch.freq >> ch.sweepShift);
    if (newFreq >= 0 && newFreq < 2048) ch.freq = newFreq;
  }

  private runSweep(): void {
    const ch = this.ch[0];
    if (ch.sweepPeriod === 0) return;
    if (ch.sweepTimer > 0) ch.sweepTimer--;
    if (ch.sweepTimer <= 0) {
      ch.sweepTimer = ch.sweepPeriod || 8;
      this.sweepCalc(ch);
      if (ch.sweepEnabled && ch.sweepShift !== 0) {
        const newFreq = ch.freq + ch.sweepDir * (ch.freq >> ch.sweepShift);
        if (newFreq < 0 || newFreq >= 2048) ch.active = false;
        else ch.freq = newFreq;
      }
    }
  }

  private updateNR52(): void {
    // NR52 lower 4 bits mirror channel on/off.
    let mask = 0;
    if (this.ch[0].active) mask |= 0x01;
    if (this.ch[1].active) mask |= 0x02;
    if (this.ch[2].active) mask |= 0x04;
    if (this.ch[3].active) mask |= 0x08;
    this.NR52 = (this.NR52 & (0x80 | 0x70)) | mask;
  }

  private powerOff(): void {
    for (const ch of this.ch) { ch.active = false; ch.enabled = false; }
    this.NR52 &= 0x70; // clear all channel-on bits, keep volume registers
  }

  // ---- frame sequencer ----------------------------------------------------

  private advanceFrameSequencer(cycles: number): void {
    this.frameSequencerCounter += cycles;
    const period = FRAME_SEQ_CYCLES;
    while (this.frameSequencerCounter >= period) {
      this.frameSequencerCounter -= period;
      this.stepFrameSequencer();
    }
  }

  private stepFrameSequencer(): void {
    const step = this.frameSequencer = (this.frameSequencer + 1) & 7;

    // Length counters run on steps 0,2,4,6.
    if ((step & 1) === 0) this.clockLength(0);
    if ((step & 1) === 0) this.clockLength(1);
    if (step % 2 === 0) this.clockLength(2);
    if ((step & 1) === 0) this.clockLength(3);

    // Sweep on steps 2 and 6.
    if (step === 2 || step === 6) {
      this.runSweep();
    }

    // Envelope on steps 2,4,6,7 (approx 128/256 Hz).
    if (step === 2 || step === 4 || step === 6 || step === 7) {
      this.clockEnvelope(0);
      this.clockEnvelope(1);
      this.clockEnvelope(3);
    }
  }

  private clockLength(idx: number): void {
    const ch = this.ch[idx];
    if (ch.lengthEnable && ch.length > 0) {
      ch.length--;
      if (ch.length === 0) { ch.active = false; this.updateNR52(); }
    }
  }

  private clockEnvelope(idx: number): void {
    const ch = this.ch[idx];
    if (!ch.active || !ch.dacOn) return;
    if (ch.envTimer > 0) ch.envTimer--;
    if (ch.envTimer === 0) {
      ch.envTimer = ch.envPeriod + 1;
      const next = ch.volume + ch.envDir;
      if (next >= 0 && next <= 15) ch.volume = next;
    }
  }

  // ---- sample generation --------------------------------------------------

  step(cycles: number): void {
    if (cycles <= 0) return;
    this.advanceFrameSequencer(cycles);
    this.clockCounter += cycles;
    const cps = CLOCK_HZ / this.sampleRate;
    while (this.clockCounter >= cps) {
      this.clockCounter -= cps;
      this.clockChannels(cps);
      this.pushMixedSample();
    }
  }

  private clockChannels(cycles: number): void {
    this.clockPulse(this.ch[0], cycles);
    this.clockPulse(this.ch[1], cycles);
    this.clockWave(cycles);
    this.clockNoise(cycles);
  }

  private clockPulse(ch: ChannelState, cycles: number): void {
    if (!ch.active || !ch.dacOn) return;
    // Full square period (in the 4.194 MHz APU clock domain) = 32*(2048-freq):
    // 16*(2048-freq) PSG periods, and the APU clock is 2x the PSG clock.
    const period = (2048 - ch.freq) * 32;
    if (period <= 0) return;
    ch.phase = (ch.phase + cycles) % period;
  }

  private clockWave(cycles: number): void {
    const ch = this.ch[2];
    if (!ch.active || !ch.dacOn) return;
    // Wave channel advances one 4-bit sample every 2*(2048-freq) PSG periods,
    // so a full 32-sample cycle = 64*(2048-freq) APU clock cycles.
    const period = (2048 - ch.freq) * 64;
    if (period <= 0) return;
    ch.phase = (ch.phase + cycles) % period;
  }

  private clockNoise(cycles: number): void {
    const ch = this.ch[3];
    if (!ch.active || !ch.dacOn) return;
    const divisor = NOISE_DIVISORS[this.NR43 & 0x07];
    const shift = (this.NR43 >> 4) & 0x0F;
    const period = divisor << shift;
    if (period <= 0) return;
    ch.noiseT += cycles;
    while (ch.noiseT >= period) {
      ch.noiseT -= period;
      const width7 = (this.NR43 & 0x08) !== 0;
      const xor = (ch.lfsr & 0x01) ^ ((ch.lfsr >> 1) & 0x01);
      ch.lfsr = (ch.lfsr >> 1) | (xor << 14);
      if (width7) ch.lfsr = (ch.lfsr & 0xFF7F) | (xor << 6);
    }
  }

  private pulseLevel(ch: ChannelState): number {
    if (!ch.active || !ch.dacOn) return 0;
    const period = (2048 - ch.freq) * 32;
    if (period <= 0) return 0;
    const stepLen = period / 8;
    const idx = Math.floor(ch.phase / stepLen) & 7;
    const on = DUTY_TABLE[ch.duty][idx] === 1;
    // Unipolar 0..15 in the 0..15 DAC range, like the GB chip.
    return on ? ch.volume : 0;
  }

  private waveLevel(): number {
    const ch = this.ch[2];
    if (!ch.active || !ch.dacOn) return 0;
    const period = (2048 - ch.freq) * 64;
    if (period <= 0) return 0;
    const stepLen = period / 32;
    const pos = Math.floor(ch.phase / stepLen) & 31;
    const byte = this.waveRam[pos >> 1];
    const nibble = (pos & 1) ? (byte & 0x0F) : (byte >> 4);
    const level = (this.NR32 >> 5) & 0x03;
    // Wave channel stays in the 0..15 DAC range (volume shift only).
    const shift = level === 0 ? 4 : level === 1 ? 0 : level === 2 ? 1 : 2;
    return nibble >> shift;
  }

  private noiseLevel(): number {
    const ch = this.ch[3];
    if (!ch.active || !ch.dacOn) return 0;
    const on = (ch.lfsr & 0x01) !== 0;
    // Unipolar 0..15 (0 when the LFSR bit is off).
    return on ? ch.volume : 0;
  }

  private pushMixedSample(): void {
    // Each channel is a unipolar 0..15 DAC value (the same range the GB chip
    // produces). We sum the panned channels, then remove the inherent DAC DC
    // with the AC-coupling high-pass (which centers the waveform on 0), apply
    // a gentle one-pole low-pass to soften hard square/noise edges, then scale
    // by NR50. Dividing by 30 keeps the largest 4-channel peak near ±1.0 so
    // nothing gets hard-clipped; the DC blocker handles the bias.
    const pl = this.pulseLevel(this.ch[0]);
    const pr = this.pulseLevel(this.ch[1]);
    const w = this.waveLevel();
    const n = this.noiseLevel();

    const panL = [0x01, 0x02, 0x04, 0x08];
    const panR = [0x10, 0x20, 0x40, 0x80];
    const vals = [pl, pr, w, n];

    let leftSum = 0;
    let rightSum = 0;
    for (let i = 0; i < 4; i++) {
      const v = vals[i];
      if (this.NR51 & panL[i]) leftSum += v;
      if (this.NR51 & panR[i]) rightSum += v;
    }

    // AC-couple (remove the DC the unipolar DACs introduce), ~35 Hz corner.
    const dcL = leftSum - this.dcPrevXL + DC_R * this.dcPrevYL;
    this.dcPrevXL = leftSum; this.dcPrevYL = dcL;
    const dcR = rightSum - this.dcPrevXR + DC_R * this.dcPrevYR;
    this.dcPrevXR = rightSum; this.dcPrevYR = dcR;

    // Gentle one-pole low-pass to tame hard square/noise edges (anti-alias).
    this.lpYL += LPF_A * (dcL - this.lpYL);
    this.lpYR += LPF_A * (dcR - this.lpYR);

    // NR50 master gain (0..7 -> 1/8..1) and fixed normalization (30 = the
    // 4-channel DAC sum midpoint, so a full mix reaches ~±1.0 without clip).
    const leftMaster = ((this.NR50 & 0x07) + 1) / 8;
    const rightMaster = (((this.NR50 >> 4) & 0x07) + 1) / 8;
    let left = this.lpYL * (leftMaster / 30);
    let right = this.lpYR * (rightMaster / 30);

    // Safety clamp for any LPF/DC transient (never reached in steady state).
    left = Math.max(-1, Math.min(1, left));
    right = Math.max(-1, Math.min(1, right));

    this.sampleBuffer.push(left, right);
  }

  // Return and clear the accumulated interleaved stereo samples.
  readSamples(): Float32Array {
    if (this.sampleBuffer.length === 0) return new Float32Array(0);
    const out = new Float32Array(this.sampleBuffer.length);
    for (let i = 0; i < this.sampleBuffer.length; i++) out[i] = this.sampleBuffer[i];
    this.sampleBuffer.length = 0;
    return out;
  }

  reset(): void {
    this.NR10 = 0x80; this.NR11 = 0xBF; this.NR12 = 0xF3; this.NR13 = 0xFF; this.NR14 = 0xBF;
    this.NR21 = 0x3F; this.NR22 = 0x00; this.NR23 = 0xFF; this.NR24 = 0xBF;
    this.NR30 = 0x7F; this.NR31 = 0xFF; this.NR32 = 0x9F; this.NR33 = 0xFF; this.NR34 = 0xBF;
    this.NR41 = 0xFF; this.NR42 = 0x00; this.NR43 = 0x00; this.NR44 = 0xBF;
    this.NR50 = 0x77; this.NR51 = 0xF3; this.NR52 = 0xF1;
    this.waveRam.fill(0);
    this.frameSequencer = 0;
    this.frameSequencerCounter = 0;
    this.clockCounter = 0;
    this.sampleBuffer.length = 0;
    this.dcPrevXL = 0; this.dcPrevYL = 0; this.lpYL = 0;
    this.dcPrevXR = 0; this.dcPrevYR = 0; this.lpYR = 0;
    this.ch = [
      this.makeChannel(),
      this.makeChannel(),
      this.makeChannel(),
      this.makeChannel(),
    ];
    this.ch[2].dacOn = (this.NR30 & 0x80) !== 0;
  }

  getState(): Uint8Array {
    const state = new Uint8Array(46);
    const view = new DataView(state.buffer);
    state.set(this.waveRam, 0);
    state.set([1], 16); // "enabled" flag preserved for save compatibility
    view.setUint8(17, this.NR10);
    view.setUint8(18, this.NR11);
    view.setUint8(19, this.NR12);
    view.setUint8(20, this.NR13);
    view.setUint8(21, this.NR14);
    view.setUint8(22, this.NR21);
    view.setUint8(23, this.NR22);
    view.setUint8(24, this.NR23);
    view.setUint8(25, this.NR24);
    view.setUint8(26, this.NR30);
    view.setUint8(27, this.NR31);
    view.setUint8(28, this.NR32);
    view.setUint8(29, this.NR33);
    view.setUint8(30, this.NR34);
    view.setUint8(31, this.NR41);
    view.setUint8(32, this.NR42);
    view.setUint8(33, this.NR43);
    view.setUint8(34, this.NR44);
    view.setUint8(35, this.NR50);
    view.setUint8(36, this.NR51);
    view.setUint8(37, this.NR52);
    view.setUint32(38, this.frameSequencerCounter, true);
    view.setUint32(42, this.frameSequencer, true);
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 37) throw new Error("Invalid APU state");
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    this.waveRam.set(state.subarray(0, 16));
    this.NR10 = view.getUint8(17);
    this.NR11 = view.getUint8(18);
    this.NR12 = view.getUint8(19);
    this.NR13 = view.getUint8(20);
    this.NR14 = view.getUint8(21);
    this.NR21 = view.getUint8(22);
    this.NR22 = view.getUint8(23);
    this.NR23 = view.getUint8(24);
    this.NR24 = view.getUint8(25);
    this.NR30 = view.getUint8(26);
    this.NR31 = view.getUint8(27);
    this.NR32 = view.getUint8(28);
    this.NR33 = view.getUint8(29);
    this.NR34 = view.getUint8(30);
    this.NR41 = view.getUint8(31);
    this.NR42 = view.getUint8(32);
    this.NR43 = view.getUint8(33);
    this.NR44 = view.getUint8(34);
    this.NR50 = view.getUint8(35);
    this.NR51 = view.getUint8(36);
    this.NR52 = view.getUint8(37);
    if (state.length >= 46) {
      this.frameSequencerCounter = view.getUint32(38, true);
      this.frameSequencer = view.getUint32(42, true) & 7;
    }
    // Re-derive channel state from registers.
    this.resetChannelsFromRegs();
  }

  private resetChannelsFromRegs(): void {
    this.ch = [
      this.makeChannel(),
      this.makeChannel(),
      this.makeChannel(),
      this.makeChannel(),
    ];
    this.ch[0].dacOn = (this.NR12 & 0x80) !== 0;
    this.ch[0].duty = (this.NR11 >> 6) & 0x03;
    this.ch[0].volume = (this.NR12 >> 4) & 0x0F;
    this.ch[0].freq = ((this.NR14 & 0x07) << 8) | this.NR13;
    this.ch[1].dacOn = (this.NR22 & 0x80) !== 0;
    this.ch[1].duty = (this.NR21 >> 6) & 0x03;
    this.ch[1].volume = (this.NR22 >> 4) & 0x0F;
    this.ch[1].freq = ((this.NR24 & 0x07) << 8) | this.NR23;
    this.ch[2].dacOn = (this.NR30 & 0x80) !== 0;
    this.ch[2].freq = ((this.NR34 & 0x07) << 8) | this.NR33;
    this.ch[3].dacOn = (this.NR42 & 0x80) !== 0;
    this.ch[3].volume = (this.NR42 >> 4) & 0x0F;
    for (const ch of this.ch) ch.active = ch.dacOn;
    this.updateNR52();
  }
}