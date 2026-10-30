// AudioWorklet processor for the Game Boy emulator.
//
// The main thread produces interleaved stereo Float32 samples during
// runFrame() (drained via gb.apu.readSamples()) and posts them to this
// processor over a MessagePort. The processor buffers them in a ring buffer
// and outputs frames (L,R) driven by the audio rendering thread. This runs on
// the audio thread, so it never blocks the emulator or the UI.
//
// The worklet runs in the AudioWorkletGlobalScope, where `sampleRate`,
// `AudioWorkletProcessor` and `registerProcessor` are provided by the browser.

const BUFFER_SECONDS = 2

class GBAudioWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Interleaved L,R samples. Ring buffer of ~2s so the emulator can sustain
    // short bursts without audible dropouts.
    const maxSamples = Math.ceil(sampleRate * BUFFER_SECONDS) * 2
    this._buf = new Float32Array(maxSamples)
    this._write = 0
    this._read = 0
    this._count = 0
    this.port.onmessage = (event) => this._enqueue(event.data)
  }

  _enqueue(data) {
    if (!data || !data.length) return
    for (let i = 0; i < data.length; i++) {
      if (this._count >= this._buf.length) {
        // Buffer is full — drop the oldest sample to keep latency bounded.
        this._read = (this._read + 1) % this._buf.length
        this._count--
      }
      this._buf[this._write] = data[i]
      this._write = (this._write + 1) % this._buf.length
      this._count++
    }
  }

  _readFrame() {
    if (this._count < 2) {
      // Underrun — realign (drop any partial sample) and emit silence.
      this._read = this._write
      this._count = 0
      return [0, 0]
    }
    const left = this._buf[this._read]
    const right = this._buf[(this._read + 1) % this._buf.length]
    this._read = (this._read + 2) % this._buf.length
    this._count -= 2
    return [left, right]
  }

  process(_inputs, outputs, _parameters) {
    const output = outputs[0]
    if (!output || output.length < 2) return true
    const left = output[0]
    const right = output[1]
    const n = left.length
    for (let i = 0; i < n; i++) {
      const frame = this._readFrame()
      left[i] = frame[0]
      right[i] = frame[1]
    }
    // Keep the processor alive for the lifetime of the AudioContext.
    return true
  }
}

registerProcessor('gb-audio-processor', GBAudioWorkletProcessor)