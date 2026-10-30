import sys, wave, struct
import numpy as np

def load_wav(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        ch = w.getnchannels()
        sr = w.getframerate()
        data = w.readframes(n)
    x = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    if ch == 2:
        left = x[0::2]
        right = x[1::2]
    else:
        left = x
        right = x
    return left, right, sr

def analyze(path):
    left, right, sr = load_wav(path)
    mono = (left + right) / 2
    print(f"\n=== {path}  sr={sr}  len={len(mono)/sr:.2f}s ===")

    # Clip / saturation detection
    hard = np.mean(np.abs(mono) >= 0.999)
    peak = np.max(np.abs(mono))
    print(f"peak={peak:.3f}  frac|<|>=0.999| (clipped) = {hard*100:.2f}%")

    # DC offset
    print(f"DC offset (mean) = {np.mean(mono):.5f}")

    # Intersample peaks (crude: detect |x[n]| > local neighbors)\n    # not needed; use crest factor
    rms = np.sqrt(np.mean(mono ** 2))
    crest = peak / (rms if rms > 0 else 1)
    print(f"RMS={rms:.4f}  crest factor={crest:.1f} (squareish waves give ~1.0-1.4; sine ~1.41; harsh/clipped lower)")

    # Zero crossings across the whole file
    zc = np.mean(np.diff(np.signbit(mono)) != 0)
    print(f"zero-crossing rate = {zc:.4f} /sample = {zc*sr:.0f}/s")

    # Frequency spectrum (FFT) of a mid window
    N = 8192
    if len(mono) > N:
        window = mono[len(mono)//3 : len(mono)//3 + N]
    else:
        window = np.pad(mono, (0, N - len(mono)))
    window = window - window.mean()
    spec = np.abs(np.fft.rfft(window * np.hanning(N)))
    freqs = np.fft.rfftfreq(N, 1/sr)
    # top 8 spectral peaks excluding DC
    idx = np.argsort(spec)[::-1]
    top = []
    for i in idx:
        if freqs[i] < 20:  # skip DC
            continue
        top.append((freqs[i], spec[i]))
        if len(top) >= 8:
            break
    print("top spectral peaks:")
    for f, a in top:
        print(f"   {f:7.1f} Hz   amp={a:.1f}")
    # total spectral energy above 12kHz (aliasing/noise signature)
    mask = freqs > 12000
    energy_high = np.sum(spec[mask]**2)
    energy_all = np.sum(spec**2)
    print(f"energy above 12kHz = {energy_high/energy_all*100:.2f}% of total")

for p in sys.argv[1:]:
    analyze(p)