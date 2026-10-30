export function toHex8(n: number): string {
  return n.toString(16).padStart(2, "0").toUpperCase();
}

export function toHex16(n: number): string {
  return n.toString(16).padStart(4, "0").toUpperCase();
}

export function getBit(value: number, bit: number): boolean {
  return ((value >> bit) & 1) === 1;
}

export function setBit(value: number, bit: number): number {
  return value | (1 << bit);
}

export function clearBit(value: number, bit: number): number {
  return value & ~(1 << bit);
}

export function testBit(value: number, bit: number): number {
  return (value >> bit) & 1;
}

export function toBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
