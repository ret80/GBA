import { InterruptType } from "./types";

export class PPU {
  private gb: any;
  
  // Registers
  public LCDC: number = 0x91;
  public STAT: number = 0x00;
  public SCY: number = 0;
  public SCX: number = 0;
  public LY: number = 0;
  public LYC: number = 0;
  public BGP: number = 0xFC;
  public OBP0: number = 0xFF;
  public OBP1: number = 0xFF;
  public WY: number = 0;
  public WX: number = 0;

  // CGB registers
  public BGPI: number = 0;
  public BGPD: Uint8Array = new Uint8Array(64);
  public OBPI: number = 0;
  public OBPD: Uint8Array = new Uint8Array(64);
  public VBK: number = 0;
  public vram: Uint8Array[] = [new Uint8Array(0x2000), new Uint8Array(0x2000)];
  public wramBank: number = 1;

  public mode: number = 2;
  private modeClock: number = 0;
  private frameBuffer: Uint32Array = new Uint32Array(160 * 144);
  // CGB per-pixel info from the tilemap attributes (bank 1)
  private bgPriority: Uint8Array = new Uint8Array(160 * 144);
  private bgColorIdx: Uint8Array = new Uint8Array(160 * 144);

  // Palettes
  private bgPalettes: number[][] = Array(8).fill(0).map(() => [0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000]);
  private objPalettes: number[][] = Array(8).fill(0).map(() => [0x00000000, 0xFFAAAAAA, 0xFF555555, 0xFF000000]);

  constructor(gb: any) {
    this.gb = gb;
    this.updatePalettes();
  }

  updatePalettes(): void {
    // Update CGB palettes from BGPD/OBPD
    for (let p = 0; p < 8; p++) {
      for (let c = 0; c < 4; c++) {
        const idx = p * 8 + c * 2;
        const color = this.BGPD[idx] | (this.BGPD[idx + 1] << 8);
        const r = (color & 0x1F) << 3;
        const g = ((color >> 5) & 0x1F) << 3;
        const b = ((color >> 10) & 0x1F) << 3;
        this.bgPalettes[p][c] = 0xFF000000 | (r << 16) | (g << 8) | b;
      }
    }
    for (let p = 0; p < 8; p++) {
      for (let c = 0; c < 4; c++) {
        const idx = p * 8 + c * 2;
        const color = this.OBPD[idx] | (this.OBPD[idx + 1] << 8);
        if (c === 0) {
          this.objPalettes[p][c] = 0x00000000; // Transparent
        } else {
          const r = (color & 0x1F) << 3;
          const g = ((color >> 5) & 0x1F) << 3;
          const b = ((color >> 10) & 0x1F) << 3;
          this.objPalettes[p][c] = 0xFF000000 | (r << 16) | (g << 8) | b;
        }
      }
    }
  }

  step(cycles: number): void {
    if (!(this.LCDC & 0x80)) {
      this.LY = 0;
      this.modeClock = 0;
      this.mode = 0;
      this.STAT = (this.STAT & 0xFC);
      return;
    }

    this.modeClock += cycles;

    switch (this.mode) {
      case 2: // OAM Search
        if (this.modeClock >= 80) {
          this.modeClock -= 80;
          this.mode = 3;
        }
        break;
      case 3: // Pixel Transfer
        if (this.modeClock >= 172) {
          this.modeClock -= 172;
          this.mode = 0;
          this.renderScanline();
          if (this.STAT & 0x08) {
            if (this.gb.interrupts) this.gb.interrupts.request(InterruptType.LCD_STAT);
          }
        }
        break;
      case 0: // HBlank
        if (this.modeClock >= 204) {
          this.modeClock -= 204;
          this.LY++;
          
          if (this.LY === 144) {
            this.mode = 1;
            if (this.gb.interrupts) {
              this.gb.interrupts.request(InterruptType.VBlank);
            }
            if (this.STAT & 0x10) {
              this.gb.interrupts.request(InterruptType.LCD_STAT);
            }
          } else {
            this.mode = 2;
            if (this.STAT & 0x20) {
              this.gb.interrupts.request(InterruptType.LCD_STAT);
            }
          }
          this.checkLYC();
        }
        break;
      case 1: // VBlank
        if (this.modeClock >= 456) {
          this.modeClock -= 456;
          this.LY++;
          if (this.LY > 153) {
            this.LY = 0;
            this.mode = 2;
            if (this.STAT & 0x20) {
              this.gb.interrupts.request(InterruptType.LCD_STAT);
            }
          }
          this.checkLYC();
        }
        break;
    }
    this.STAT = (this.STAT & 0xFC) | this.mode;
  }

  private checkLYC(): void {
    if (this.LY === this.LYC) {
      this.STAT |= 0x04;
      if (this.STAT & 0x40) {
        if (this.gb.interrupts) this.gb.interrupts.request(InterruptType.LCD_STAT);
      }
    } else {
      this.STAT &= 0xFB;
    }
  }

  private getMemory(): any {
    return this.gb.memory;
  }

  private renderScanline(): void {
    if (this.LY > 143) return;
    const mem = this.getMemory();
    const isCGB = this.gb.cartridge && this.gb.cartridge.isCGB;
    
    // Clear line
    for (let x = 0; x < 160; x++) {
      if (!(this.LCDC & 0x01)) {
        this.frameBuffer[this.LY * 160 + x] = isCGB ? this.bgPalettes[0][0] : 0xFFFFFFFF;
      } else {
        this.frameBuffer[this.LY * 160 + x] = this.getBgColor(0, isCGB);
      }
      this.bgPriority[this.LY * 160 + x] = 0;
      this.bgColorIdx[this.LY * 160 + x] = 0;
    }

    // Render background
    if (this.LCDC & 0x01) {
      this.renderBackground(isCGB);
    }

    // Render window
    if ((this.LCDC & 0x20) && this.WY <= this.LY) {
      this.renderWindow(isCGB);
    }

    // Render sprites
    if (this.LCDC & 0x02) {
      this.renderSprites(mem, isCGB);
    }
  }

  private getBgColor(paletteIndex: number, isCGB: boolean): number {
    if (isCGB) {
      return this.bgPalettes[paletteIndex & 0x07][0];
    }
    const color = (this.BGP >> 0) & 0x03;
    const colors = [0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000];
    return colors[color];
  }

  private renderBackground(isCGB: boolean): void {
    const tileMapBase = (this.LCDC & 0x08) ? 0x9C00 : 0x9800;
    const tileDataBase = (this.LCDC & 0x10) ? 0x8000 : 0x8800;
    const unsigned = (this.LCDC & 0x10) !== 0;

    for (let x = 0; x < 160; x++) {
      const pixelX = (x + this.SCX) & 0xFF;
      const pixelY = (this.LY + this.SCY) & 0xFF;
      
      const tileX = Math.floor(pixelX / 8);
      const tileY = Math.floor(pixelY / 8);
      const tileMapAddr = tileMapBase + tileY * 32 + tileX;

      // CGB tile attributes live in VRAM bank 1 at the same tilemap offset.
      // PPU always fetches the tilemap from bank 0 regardless of the VBK register.
      let attr = 0;
      if (isCGB) {
        attr = this.gb.ppu.vram && this.gb.ppu.vram[1] ? this.gb.ppu.vram[1][tileMapAddr - 0x8000] : 0;
      }

      const mapBank = this.gb.ppu.vram[0] || this.gb.ppu.vram[1];
      let tileIndex = mapBank[tileMapAddr - 0x8000];
      if (!unsigned) {
        tileIndex = (tileIndex << 24) >> 24;
      }
      
      const tileAddr = unsigned ? tileDataBase + tileIndex * 16 : tileDataBase + (tileIndex + 128) * 16;
      const tileRow = pixelY % 8;
      const tileCol = pixelX % 8;
      const flipY = isCGB && (attr & 0x40) !== 0;
      const flipX = isCGB && (attr & 0x20) !== 0;
      const effRow = flipY ? 7 - tileRow : tileRow;
      const effCol = flipX ? 7 - tileCol : tileCol;

      const tileBank = isCGB ? ((attr & 0x08) ? 1 : 0) : 0;
      const vramBank = this.gb.ppu.vram[tileBank] || this.gb.ppu.vram[0];
      const tileOffset = tileAddr - 0x8000;
      let byte1 = vramBank[tileOffset + effRow * 2];
      let byte2 = vramBank[tileOffset + effRow * 2 + 1];
      
      const bit = 7 - effCol;
      const colorIndex = ((byte2 >> bit) & 1) << 1 | ((byte1 >> bit) & 1);

      const palette = isCGB ? (attr & 0x07) : 0;
      let color: number;
      if (isCGB) {
        color = this.bgPalettes[palette][colorIndex];
      } else {
        color = this.getDmgColor(colorIndex, this.BGP);
      }
      
      const fbIdx = this.LY * 160 + x;
      this.frameBuffer[fbIdx] = color;
      this.bgPriority[fbIdx] = isCGB && (attr & 0x80) ? 1 : 0;
      this.bgColorIdx[fbIdx] = colorIndex;
    }
  }

  private renderWindow(isCGB: boolean): void {
    if (this.WX > 166) return;
    const tileMapBase = (this.LCDC & 0x40) ? 0x9C00 : 0x9800;
    const tileDataBase = (this.LCDC & 0x10) ? 0x8000 : 0x8800;
    const unsigned = (this.LCDC & 0x10) !== 0;

    for (let x = 0; x < 160; x++) {
      const wx = x - (this.WX - 7);
      if (wx < 0) continue;
      if (wx >= 160) break;
      
      const tileX = Math.floor(wx / 8);
      const tileY = Math.floor((this.LY - this.WY) / 8);
      const tileMapAddr = tileMapBase + tileY * 32 + tileX;
      
      let attr = 0;
      if (isCGB) {
        attr = this.gb.ppu.vram && this.gb.ppu.vram[1] ? this.gb.ppu.vram[1][tileMapAddr - 0x8000] : 0;
      }

      // PPU always fetches tilemap indices from VRAM bank 0, regardless of VBK.
      const mapBank = this.gb.ppu.vram[0] || this.gb.ppu.vram[1];
      let tileIndex = mapBank[tileMapAddr - 0x8000];
      if (!unsigned) {
        tileIndex = (tileIndex << 24) >> 24;
      }
      
      const tileAddr = unsigned ? tileDataBase + tileIndex * 16 : tileDataBase + (tileIndex + 128) * 16;
      const tileRow = (this.LY - this.WY) % 8;
      const tileCol = wx % 8;
      const flipY = isCGB && (attr & 0x40) !== 0;
      const flipX = isCGB && (attr & 0x20) !== 0;
      const effRow = flipY ? 7 - tileRow : tileRow;
      const effCol = flipX ? 7 - tileCol : tileCol;

      const tileBank = isCGB ? ((attr & 0x08) ? 1 : 0) : 0;
      const vramBank = this.gb.ppu.vram[tileBank] || this.gb.ppu.vram[0];
      const tileOffset = tileAddr - 0x8000;
      let byte1 = vramBank[tileOffset + effRow * 2];
      let byte2 = vramBank[tileOffset + effRow * 2 + 1];
      
      const bit = 7 - effCol;
      const colorIndex = ((byte2 >> bit) & 1) << 1 | ((byte1 >> bit) & 1);

      const palette = isCGB ? (attr & 0x07) : 0;
      let color: number;
      if (isCGB) {
        color = this.bgPalettes[palette][colorIndex];
      } else {
        color = this.getDmgColor(colorIndex, this.BGP);
      }
      
      const fbIdx = this.LY * 160 + x;
      this.frameBuffer[fbIdx] = color;
      this.bgPriority[fbIdx] = isCGB && (attr & 0x80) ? 1 : 0;
      this.bgColorIdx[fbIdx] = colorIndex;
    }
  }

  private renderSprites(mem: any, isCGB: boolean): void {
    const spriteHeight = (this.LCDC & 0x04) ? 16 : 8;
    
    // CGB: higher OAM index = higher priority (paint later/front).
    // DMG: higher OAM index = lower priority (paint earlier/behind).
    const order: number[] = [];
    for (let s = 0; s < 40; s++) order.push(s);
    if (isCGB) order.reverse();

    for (const sprite of order) {
      const addr = 0xFE00 + sprite * 4;
      const y = mem.read8(addr) - 16;
      const x = mem.read8(addr + 1) - 8;
      const tileIndex = mem.read8(addr + 2);
      const attr = mem.read8(addr + 3);
      
      if (y > this.LY || y + spriteHeight <= this.LY) continue;
      if (x < -7 || x >= 160) continue;
      
      const yFlip = (attr & 0x40) !== 0;
      const xFlip = (attr & 0x20) !== 0;
      const palette = isCGB ? (attr & 0x07) : ((attr & 0x10) ? 1 : 0);

      const tileBank = isCGB ? ((attr & 0x08) ? 1 : 0) : 0;
      const vramBank = this.gb.ppu.vram[tileBank] || this.gb.ppu.vram[0];
      
      let tileRow = this.LY - y;
      if (yFlip) tileRow = spriteHeight - 1 - tileRow;
      
      const tileAddr = 0x8000 + (spriteHeight === 16 ? (tileIndex & 0xFE) * 16 : tileIndex * 16) + tileRow * 2;
      const tileOffset = tileAddr - 0x8000;
      let byte1 = vramBank[tileOffset];
      let byte2 = vramBank[tileOffset + 1];
      
      for (let px = 0; px < 8; px++) {
        const pixelX = x + px;
        if (pixelX < 0 || pixelX >= 160) continue;
        
        let bit = px;
        if (!xFlip) bit = 7 - px;
        
        const colorIndex = ((byte2 >> bit) & 1) << 1 | ((byte1 >> bit) & 1);
        if (colorIndex === 0) continue; // Transparent
        

        
        let color: number;
        if (isCGB) {
          color = this.objPalettes[palette][colorIndex];
        } else {
          const pal = palette === 0 ? this.OBP0 : this.OBP1;
          color = this.getDmgColor(colorIndex, pal);
        }
        
        if (color !== 0x00000000) {
          const fbIdx = this.LY * 160 + pixelX;
          if (isCGB && (attr & 0x80) && this.bgPriority[fbIdx]) continue;
          this.frameBuffer[fbIdx] = color;
        }
      }
    }
  }

  private getDmgColor(index: number, palette: number): number {
    const color = (palette >> (index * 2)) & 0x03;
    const colors = [0xFFFFFFFF, 0xFFAAAAAA, 0xFF555555, 0xFF000000];
    return colors[color];
  }

  getFrameBuffer(): Uint32Array {
    return this.frameBuffer;
  }

  getState(): Uint8Array {
    const state = new Uint8Array(0x4000 + 64 + 64 + 19 + 160 * 144 * 4);
    const view = new DataView(state.buffer);
    state.set(this.vram[0], 0);
    state.set(this.vram[1], 0x2000);
    state.set(this.BGPD, 0x4000);
    state.set(this.OBPD, 0x4040);
    let off = 0x4080;
    view.setUint8(off, this.LCDC); off += 1;
    view.setUint8(off, this.STAT); off += 1;
    view.setUint8(off, this.SCY); off += 1;
    view.setUint8(off, this.SCX); off += 1;
    view.setUint8(off, this.LY); off += 1;
    view.setUint8(off, this.LYC); off += 1;
    view.setUint8(off, this.BGP); off += 1;
    view.setUint8(off, this.OBP0); off += 1;
    view.setUint8(off, this.OBP1); off += 1;
    view.setUint8(off, this.WY); off += 1;
    view.setUint8(off, this.WX); off += 1;
    view.setUint8(off, this.BGPI); off += 1;
    view.setUint8(off, this.OBPI); off += 1;
    view.setUint8(off, this.VBK); off += 1;
    view.setUint8(off, this.mode); off += 1;
    view.setUint32(off, this.modeClock, true);
    off += 4;
    for (let i = 0; i < this.frameBuffer.length; i++) {
      view.setUint32(off, this.frameBuffer[i], true);
      off += 4;
    }
    return state;
  }

  setState(state: Uint8Array): void {
    if (state.length < 0x4000 + 64 + 64 + 19) throw new Error("Invalid PPU state");
    const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
    this.vram[0].set(state.subarray(0, 0x2000));
    this.vram[1].set(state.subarray(0x2000, 0x4000));
    this.BGPD.set(state.subarray(0x4000, 0x4040));
    this.OBPD.set(state.subarray(0x4040, 0x4080));
    let off = 0x4080;
    this.LCDC = view.getUint8(off); off += 1;
    this.STAT = view.getUint8(off); off += 1;
    this.SCY = view.getUint8(off); off += 1;
    this.SCX = view.getUint8(off); off += 1;
    this.LY = view.getUint8(off); off += 1;
    this.LYC = view.getUint8(off); off += 1;
    this.BGP = view.getUint8(off); off += 1;
    this.OBP0 = view.getUint8(off); off += 1;
    this.OBP1 = view.getUint8(off); off += 1;
    this.WY = view.getUint8(off); off += 1;
    this.WX = view.getUint8(off); off += 1;
    this.BGPI = view.getUint8(off); off += 1;
    this.OBPI = view.getUint8(off); off += 1;
    this.VBK = view.getUint8(off); off += 1;
    this.mode = view.getUint8(off); off += 1;
    this.modeClock = view.getUint32(off, true);
    off += 4;
    if (off + this.frameBuffer.length * 4 <= state.length) {
      for (let i = 0; i < this.frameBuffer.length; i++) {
        this.frameBuffer[i] = view.getUint32(off, true);
        off += 4;
      }
    }
    this.updatePalettes();
  }

  reset(): void {
    this.LCDC = 0x91;
    this.STAT = 0x00;
    this.SCY = 0;
    this.SCX = 0;
    this.LY = 0;
    this.LYC = 0;
    this.BGP = 0xFC;
    this.OBP0 = 0xFF;
    this.OBP1 = 0xFF;
    this.WY = 0;
    this.WX = 0;
    this.BGPI = 0;
    this.OBPI = 0;
    this.VBK = 0;
    // On real CGB, after boot all palette RAM is initialized to white (0xFFFF).
    this.BGPD.fill(0xFF);
    this.OBPD.fill(0xFF);
    this.vram[0].fill(0);
    this.vram[1].fill(0);
    this.mode = 2;
    this.modeClock = 0;
    this.frameBuffer.fill(0xFFFFFFFF);
    this.updatePalettes();
  }
}
