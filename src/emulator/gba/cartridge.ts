// GBA cartridge: ROM image plus backup memory (SRAM / Flash).
//
// The save type is detected from the marker strings ("SRAM_V", "FLASH_V",
// "FLASH1M_V", "EEPROM_V") that Nintendo's SDK links into every ROM. EEPROM is
// a serial device; it is detected but not implemented here, so those games
// boot but cannot save.

export type GbaSaveType = "none" | "sram" | "flash64" | "flash128" | "eeprom";

export class GbaCartridge {
  public rom: Uint8Array = new Uint8Array(0);
  public saveType: GbaSaveType = "none";
  public save: Uint8Array = new Uint8Array(0);
  public title = "";

  // Flash command state machine.
  private flashMode: "read" | "id" | "erase" | "write" | "bank" = "read";
  private flashStage = 0;
  private flashBank = 0;
  private flashWriteOffset = -1;

  load(rom: Uint8Array): void {
    this.rom = rom;
    this.title = "";
    for (let i = 0xa0; i < 0xac; i++) {
      const ch = rom[i];
      if (ch >= 0x20 && ch < 0x7f) this.title += String.fromCharCode(ch);
    }
    this.detectSaveType();
  }

  private containsMarker(marker: string): boolean {
    const first = marker.charCodeAt(0);
    const last = this.rom.length - marker.length;
    outer: for (let i = 0; i <= last; i++) {
      if (this.rom[i] !== first) continue;
      for (let j = 1; j < marker.length; j++) {
        if (this.rom[i + j] !== marker.charCodeAt(j)) continue outer;
      }
      return true;
    }
    return false;
  }

  private detectSaveType(): void {
    if (this.containsMarker("EEPROM_V")) {
      this.saveType = "eeprom";
      this.save = new Uint8Array(0x2000);
    } else if (this.containsMarker("FLASH1M_V")) {
      this.saveType = "flash128";
      this.save = new Uint8Array(0x20000);
    } else if (this.containsMarker("FLASH_V") || this.containsMarker("FLASH512_V")) {
      this.saveType = "flash64";
      this.save = new Uint8Array(0x10000);
    } else if (this.containsMarker("SRAM_V")) {
      this.saveType = "sram";
      this.save = new Uint8Array(0x8000);
    } else {
      this.saveType = "none";
      this.save = new Uint8Array(0x8000);
    }
    this.flashMode = "read";
    this.flashStage = 0;
    this.flashBank = 0;
  }

  reset(): void {
    this.flashMode = "read";
    this.flashStage = 0;
    this.flashBank = 0;
    this.flashWriteOffset = -1;
  }

  read8(addr: number): number {
    if (this.saveType === "flash64" || this.saveType === "flash128") {
      if (this.flashMode === "id") {
        return addr & 1 ? 0x1f : 0x3d;
      }
      const offset = this.flashBank * 0x10000 + (addr & 0xffff);
      return this.save[offset & (this.save.length - 1)] ?? 0xff;
    }
    return this.save[addr & (this.save.length - 1)] ?? 0xff;
  }

  write8(addr: number, value: number): void {
    if (this.save.length === 0) return;
    value &= 0xff;

    if (this.saveType !== "flash64" && this.saveType !== "flash128") {
      this.save[addr & (this.save.length - 1)] = value;
      return;
    }

    // Flash command sequences use addresses 0xE005555 / 0xE002AAA.
    const offset = addr & 0xffff;
    if (this.flashMode === "write") {
      if (this.flashWriteOffset >= 0) {
        this.save[this.flashWriteOffset] = value;
        this.flashMode = "read";
        this.flashWriteOffset = -1;
      }
      return;
    }
    if (this.flashMode === "bank") {
      this.flashBank = value & 1;
      this.flashMode = "read";
      return;
    }

    if (value === 0xf0) {
      this.flashMode = "read";
      this.flashStage = 0;
      return;
    }
    if (value === 0xaa && offset === 0x5555) {
      this.flashStage = 1;
      return;
    }
    if (value === 0x55 && offset === 0x2aaa && this.flashStage === 1) {
      this.flashStage = 2;
      return;
    }
    if (this.flashStage === 2) {
      if (value === 0x90) {
        this.flashMode = "id";
        this.flashStage = 0;
        return;
      }
      if (value === 0xa0) {
        this.flashMode = "write";
        this.flashWriteOffset = this.flashBank * 0x10000 + offset;
        this.flashStage = 0;
        return;
      }
      if (value === 0xb0) {
        this.flashMode = "bank";
        this.flashStage = 0;
        return;
      }
      if (value === 0x80) {
        this.flashMode = "erase";
        this.flashStage = 3;
        return;
      }
      this.flashStage = 0;
      return;
    }
    if (this.flashMode === "erase" && this.flashStage === 3) {
      if (value === 0x30) {
        const sector = this.flashBank * 0x10000 + (offset & 0xf000);
        this.save.fill(0xff, sector, sector + 0x1000);
        this.flashMode = "read";
        this.flashStage = 0;
      } else if (value === 0x10) {
        this.save.fill(0xff);
        this.flashMode = "read";
        this.flashStage = 0;
      }
    }
  }

  getState(): number[] {
    return [this.flashBank, this.flashStage, this.flashWriteOffset, this.flashMode === "read" ? 0 : 1];
  }

  setState(state: number[]): void {
    this.flashBank = state[0] ?? 0;
    this.flashStage = state[1] ?? 0;
    this.flashWriteOffset = state[2] ?? -1;
    this.flashMode = (state[3] ?? 0) === 0 ? "read" : "id";
  }
}
