// Game Boy Advance PPU: text and affine backgrounds (modes 0-2), bitmap modes
// 3-5, OBJ sprites (including affine sprites), windows and color effects.
//
// The PPU renders one scanline at a time (at the HBlank boundary), the same
// strategy the Game Boy core uses, so register changes made during HBlank and
// VBlank are honoured.

export const SCREEN_WIDTH = 240;
export const SCREEN_HEIGHT = 160;
export const CYCLES_PER_LINE = 1232;
export const VISIBLE_LINES = 160;
export const TOTAL_LINES = 228;

const IRQ_VBLANK = 0;
const IRQ_VCOUNT = 2;

/** Sprite dimensions indexed by [shape][size]. */
const OBJ_SIZES: [number, number][][] = [
  [[8, 8], [16, 16], [32, 32], [64, 64]],
  [[16, 8], [32, 8], [32, 16], [64, 32]],
  [[8, 16], [8, 32], [16, 32], [32, 64]],
  [[0, 0], [0, 0], [0, 0], [0, 0]],
];

export class GbaPpu {
  public dispcnt = 0;
  public dispstat = 0;
  public vcount = 0;
  public bgcnt = new Uint16Array(4);
  public bghofs = new Uint16Array(4);
  public bgvofs = new Uint16Array(4);
  public bgpa = new Int16Array(2);
  public bgpb = new Int16Array(2);
  public bgpc = new Int16Array(2);
  public bgpd = new Int16Array(2);
  public bgx = new Int32Array(2);
  public bgy = new Int32Array(2);
  public win0h = 0;
  public win1h = 0;
  public win0v = 0;
  public win1v = 0;
  public winin = 0;
  public winout = 0;
  public mosaic = 0;
  public bldcnt = 0;
  public bldalpha = 0;
  public bldy = 0;

  public framebuffer: Uint32Array = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  private lineCycles = 0;
  private line = 0;
  private renderedThisLine = false;

  // Affine reference points are latch-on-write: both halves must be written.
  private affineRefLo = new Int32Array(2);

  // Per-scanline compositing buffers (allocated once).
  private colors: Uint32Array = new Uint32Array(SCREEN_WIDTH);
  private priorities: Uint8Array = new Uint8Array(SCREEN_WIDTH);
  private layers: Uint8Array = new Uint8Array(SCREEN_WIDTH);
  private objColors: Uint32Array = new Uint32Array(SCREEN_WIDTH);
  private objPriorities: Uint8Array = new Uint8Array(SCREEN_WIDTH);
  private objDrawn: Uint8Array = new Uint8Array(SCREEN_WIDTH);
  private semi: Uint8Array = new Uint8Array(SCREEN_WIDTH);
  private objWindow: Uint8Array = new Uint8Array(SCREEN_WIDTH);
  private winRegion: Uint8Array = new Uint8Array(SCREEN_WIDTH);

  // Precomputed 15-bit BGR555 -> 0xFFRRGGBB conversion table for BG palette.
  private static readonly COLOR_555 = (() => {
    const table = new Uint32Array(0x8000);
    for (let c = 0; c < 0x8000; c++) {
      const r = (c & 0x1f) << 3;
      const g = ((c >> 5) & 0x1f) << 3;
      const b = ((c >> 10) & 0x1f) << 3;
      table[c] = (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;
    }
    return table;
  })();

  private readonly machine: any;

  constructor(machine: any) {
    this.machine = machine;
  }

  get bus(): any {
    return this.machine.bus;
  }

  // ---- Register interface (offsets from 0x04000000) -----------------------

  readIO(off: number): number {
    switch (off) {
      case 0x00:
        return this.dispcnt;
      case 0x04:
        return this.dispstat;
      case 0x06:
        return this.vcount;
      case 0x08:
      case 0x0a:
      case 0x0c:
      case 0x0e:
        return this.bgcnt[(off - 0x08) >> 1];
      case 0x10:
      case 0x12:
      case 0x14:
      case 0x16:
      case 0x18:
      case 0x1a:
      case 0x1c:
      case 0x1e: {
        const bg = (off - 0x10) >> 2;
        return off & 2 ? this.bgvofs[bg] : this.bghofs[bg];
      }
      case 0x20:
      case 0x22:
      case 0x24:
      case 0x26:
      case 0x30:
      case 0x32:
      case 0x34:
      case 0x36: {
        const bg = off >= 0x30 ? 1 : 0;
        const reg = (off >> 1) & 3;
        return [this.bgpa[bg], this.bgpb[bg], this.bgpc[bg], this.bgpd[bg]][reg] & 0xffff;
      }
      case 0x28:
      case 0x2c:
      case 0x38:
      case 0x3c: {
        const bg = off >= 0x38 ? 1 : 0;
        const isY = off === 0x2c || off === 0x3c;
        const value = isY ? this.bgy[bg] : this.bgx[bg];
        return (off & 2 ? value >> 16 : value) & 0xffff;
      }
      case 0x40:
        return this.win0h;
      case 0x42:
        return this.win1h;
      case 0x44:
        return this.win0v;
      case 0x46:
        return this.win1v;
      case 0x48:
        return this.winin;
      case 0x4a:
        return this.winout;
      case 0x4c:
        return this.mosaic;
      case 0x50:
        return this.bldcnt;
      case 0x52:
        return this.bldalpha;
      case 0x54:
        return this.bldy;
      default:
        return this.bus.io16(off);
    }
  }

  writeIO(off: number, value: number): void {
    value &= 0xffff;
    switch (off) {
      case 0x00:
        this.dispcnt = value;
        return;
      case 0x04:
        this.dispstat = (this.dispstat & 0x7) | (value & 0xfff8);
        return;
      case 0x08:
      case 0x0a:
      case 0x0c:
      case 0x0e:
        this.bgcnt[(off - 0x08) >> 1] = value;
        return;
      case 0x10:
      case 0x12:
      case 0x14:
      case 0x16:
      case 0x18:
      case 0x1a:
      case 0x1c:
      case 0x1e: {
        const bg = (off - 0x10) >> 2;
        if (off & 2) this.bgvofs[bg] = value & 0x1ff;
        else this.bghofs[bg] = value & 0x1ff;
        return;
      }
      case 0x20:
      case 0x22:
      case 0x24:
      case 0x26:
      case 0x30:
      case 0x32:
      case 0x34:
      case 0x36: {
        const bg = off >= 0x30 ? 1 : 0;
        const reg = (off >> 1) & 3;
        const v = (value << 16) >> 16;
        if (reg === 0) this.bgpa[bg] = v;
        else if (reg === 1) this.bgpb[bg] = v;
        else if (reg === 2) this.bgpc[bg] = v;
        else this.bgpd[bg] = v;
        return;
      }
      case 0x28:
      case 0x2c:
      case 0x38:
      case 0x3c: {
        const bg = off >= 0x38 ? 1 : 0;
        const isY = off === 0x2c || off === 0x3c;
        const target = isY ? this.bgy : this.bgx;
        if (!(off & 2)) {
          // Low half: latch only; the high-half write commits the reference.
          if (isY) this.affineRefLo[bg] = value;
          else this.affineRefLo[bg] = value;
          return;
        }
        const lo = this.affineRefLo[bg];
        let full = ((value << 16) | lo) | 0;
        full = (full << 4) >> 4; // 28-bit signed reference point
        target[bg] = full;
        return;
      }
      case 0x40:
        this.win0h = value;
        return;
      case 0x42:
        this.win1h = value;
        return;
      case 0x44:
        this.win0v = value;
        return;
      case 0x46:
        this.win1v = value;
        return;
      case 0x48:
        this.winin = value;
        return;
      case 0x4a:
        this.winout = value;
        return;
      case 0x4c:
        this.mosaic = value;
        return;
      case 0x50:
        this.bldcnt = value;
        return;
      case 0x52:
        this.bldalpha = value;
        return;
      case 0x54:
        this.bldy = value;
        return;
      default:
        this.bus.writeIO16(off, value);
    }
  }

  // ---- Timing -------------------------------------------------------------

  step(cycles: number): void {
    this.lineCycles += cycles;
    if (!this.renderedThisLine && this.lineCycles >= 960) {
      this.renderedThisLine = true;
      if (this.line < VISIBLE_LINES) {
        this.renderScanline(this.line);
        this.machine.onHblank();
      }
    }
    while (this.lineCycles >= CYCLES_PER_LINE) {
      this.lineCycles -= CYCLES_PER_LINE;
      this.renderedThisLine = false;
      this.nextLine();
    }
  }

  private nextLine(): void {
    this.dispstat &= ~0x2; // leave HBlank
    this.line++;
    if (this.line === VISIBLE_LINES) {
      this.dispstat |= 0x1; // VBlank flag
      if (this.dispstat & 0x8) this.machine.requestIrq(IRQ_VBLANK);
      this.machine.onVBlank();
    }
    if (this.line >= TOTAL_LINES) {
      this.line = 0;
      this.dispstat &= ~0x1;
    }
    this.vcount = this.line;
    this.updateVCountMatch();
  }

  private updateVCountMatch(): void {
    const match = (this.dispstat >>> 8) === this.line;
    this.dispstat = match ? this.dispstat | 0x4 : this.dispstat & ~0x4;
    if (match && this.dispstat & 0x20) this.machine.requestIrq(IRQ_VCOUNT);
  }

  get currentLine(): number {
    return this.line;
  }

  // ---- Rendering ----------------------------------------------------------

  private palette(index: number): number {
    const bus = this.bus;
    const entry = index & 0x1ff;
    const value = bus.palette[entry * 2] | (bus.palette[entry * 2 + 1] << 8);
    return GbaPpu.COLOR_555[value & 0x7fff];
  }

  private vram16(addr: number): number {
    const vram = this.bus.vram;
    const off = addr & 0x1ffff;
    return vram[off] | (vram[off + 1] << 8);
  }

  private vram8(addr: number): number {
    return this.bus.vram[addr & 0x1ffff];
  }

  renderScanline(y: number): void {
    const fb = this.framebuffer;
    const base = y * SCREEN_WIDTH;
    const dispcnt = this.dispcnt;
    const mode = dispcnt & 0x7;
    const backdrop = this.palette(0);

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      fb[base + x] = backdrop;
      this.priorities[x] = 4;
      this.layers[x] = 0xff;
      this.colors[x] = backdrop;
      this.objPriorities[x] = 4;
      this.objDrawn[x] = 0;
      this.semi[x] = 0;
      this.objWindow[x] = 0;
    }

    if (dispcnt & 0x80 || mode > 5) {
      // Forced blank: white screen.
      fb.fill(0xffffffff, base, base + SCREEN_WIDTH);
      return;
    }

    this.buildWindowMask(y);
    this.renderObj(y);

    const bgEnabled = (dispcnt >> 8) & 0xf;
    if (mode <= 2) {
      for (let bg = 0; bg < 4; bg++) {
        if (!(bgEnabled & (1 << bg))) continue;
        if (mode === 2 && bg < 2) continue;
        if (mode === 1 && bg === 3) continue;
        this.renderBackground(y, bg);
      }
    } else {
      this.renderBitmap(y, mode);
    }

    this.composite(y);
  }

  private windowLayers(region: number): number {
    // 0 = outside, 1 = WIN0, 2 = WIN1, 3 = OBJ window.
    switch (region) {
      case 1:
        return this.winin & 0x3f;
      case 2:
        return (this.winin >> 8) & 0x3f;
      case 3:
        return (this.winout >> 8) & 0x3f;
      default:
        return this.winout & 0x3f;
    }
  }

  private buildWindowMask(y: number): void {
    const dispcnt = this.dispcnt;
    const win0On = (dispcnt & 0x2000) !== 0;
    const win1On = (dispcnt & 0x4000) !== 0;
    const win0x1 = this.win0h & 0xff;
    const win0x2 = (this.win0h >> 8) & 0xff;
    const win1x1 = this.win1h & 0xff;
    const win1x2 = (this.win1h >> 8) & 0xff;
    const win0y1 = this.win0v & 0xff;
    const win0y2 = (this.win0v >> 8) & 0xff;
    const win1y1 = this.win1v & 0xff;
    const win1y2 = (this.win1v >> 8) & 0xff;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      let region = 0;
      if (win0On && y >= win0y1 && y < win0y2 && x >= win0x1 && x < win0x2) region = 1;
      else if (win1On && y >= win1y1 && y < win1y2 && x >= win1x1 && x < win1x2) region = 2;
      this.winRegion[x] = region;
    }
  }

  private get windowsActive(): boolean {
    return (this.dispcnt & 0xe000) !== 0;
  }

  private layerVisible(x: number, bit: number): boolean {
    // With no windows enabled every layer is visible and effects are allowed.
    if (!this.windowsActive) return true;
    const region = this.winRegion[x];
    const mask = this.windowLayers(region === 0 && this.objWindow[x] ? 3 : region);
    return (mask & bit) !== 0;
  }

  private renderBackground(y: number, bg: number): void {
    const cnt = this.bgcnt[bg];
    const priority = cnt & 0x3;
    const mode = this.dispcnt & 0x7;
    const affine = (mode === 1 && bg === 2) || mode === 2;

    if (affine) {
      this.renderAffineBackground(y, bg, priority);
      return;
    }

    const charBase = ((cnt >> 2) & 0x3) * 0x4000;
    const screenBase = ((cnt >> 8) & 0x1f) * 0x800;
    const colors8 = (cnt & 0x80) !== 0;
    const size = cnt >> 14;
    const hofs = this.bghofs[bg] & 0x1ff;
    const vofs = this.bgvofs[bg] & 0x1ff;
    const palOffset = 0; // BG palette always starts at index 0

    const mapWidth = size & 1 ? 512 : 256;
    const mapHeight = size & 2 ? 512 : 256;
    const x0 = hofs;
    const y0 = vofs;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (!(this.dispcnt & (1 << (8 + bg)))) continue;
      if (!this.layerVisible(x, bg)) continue;

      const px = (x + x0) % mapWidth;
      const py = (y + y0) % mapHeight;

      let block = 0;
      let tx = px & 0xff;
      let ty = py & 0xff;
      if (mapWidth === 512 && mapHeight === 256) block = px >> 8;
      else if (mapWidth === 256 && mapHeight === 512) block = py >> 8;
      else if (mapWidth === 512 && mapHeight === 512) block = (px >> 8) | ((py >> 8) << 1);

      const mapAddr = screenBase + block * 0x800 + ((ty >> 3) * 32 + (tx >> 3)) * 2;
      const entry = this.vram16(0x06000000 + mapAddr);
      const tile = entry & 0x3ff;
      const hflip = (entry & 0x400) !== 0;
      const vflip = (entry & 0x800) !== 0;
      const palNum = (entry >> 12) & 0xf;

      const row = vflip ? 7 - (ty & 7) : ty & 7;
      const col = hflip ? 7 - (tx & 7) : tx & 7;
      const tileAddr = 0x06000000 + charBase + tile * (colors8 ? 64 : 32) + row * (colors8 ? 8 : 4);
      let colorIndex: number;
      if (colors8) {
        colorIndex = this.vram8(tileAddr + col);
      } else {
        const byte = this.vram8(tileAddr + (col >> 1));
        colorIndex = col & 1 ? byte >> 4 : byte & 0xf;
        colorIndex += palNum * 16;
      }
      if (colorIndex === 0) continue;

      if (priority < this.priorities[x]) {
        this.priorities[x] = priority;
        this.layers[x] = bg;
        this.colors[x] = this.palette(palOffset + colorIndex);
      }
    }
  }

  private renderAffineBackground(y: number, bg: number, priority: number): void {
    const cnt = this.bgcnt[bg];
    const idx = bg - 2;
    const size = cnt >> 14;
    const mapSize = 1 << (7 + size); // 128,256,512,1024
    const charBase = ((cnt >> 2) & 0x3) * 0x4000;
    const screenBase = ((cnt >> 8) & 0x1f) * 0x800;
    const wrap = (cnt & 0x2000) !== 0;

    const pa = this.bgpa[idx];
    const pb = this.bgpb[idx];
    const pc = this.bgpc[idx];
    const pd = this.bgpd[idx];
    const refX = this.bgx[idx] + pb * y;
    const refY = this.bgy[idx] + pd * y;

    if (!(this.dispcnt & (1 << (8 + bg)))) return;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (!this.layerVisible(x, bg)) continue;
      let tx = (refX + pa * x) >> 8;
      let ty = (refY + pc * x) >> 8;
      if (wrap) {
        tx &= mapSize - 1;
        ty &= mapSize - 1;
      } else if (tx < 0 || ty < 0 || tx >= mapSize || ty >= mapSize) {
        continue;
      }
      const mapAddr = screenBase + ((ty >> 3) * (mapSize >> 3) + (tx >> 3)) * 2;
      const entry = this.vram16(0x06000000 + mapAddr);
      const tile = entry & 0x3ff;
      const row = ty & 7;
      const col = tx & 7;
      const tileAddr = 0x06000000 + charBase + tile * 64 + row * 8 + col;
      const colorIndex = this.vram8(tileAddr);
      if (colorIndex === 0) continue;
      if (priority < this.priorities[x]) {
        this.priorities[x] = priority;
        this.layers[x] = bg;
        this.colors[x] = this.palette(colorIndex);
      }
    }
  }

  private renderBitmap(y: number, mode: number): void {
    const dispcnt = this.dispcnt;
    const priority = this.bgcnt[2] & 0x3;
    if (!(dispcnt & (1 << 10))) return; // BG2 disabled

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (!this.layerVisible(x, 2)) continue;
      let color = 0;
      let transparent = false;

      if (mode === 3) {
        color = this.vram16(0x06000000 + (y * SCREEN_WIDTH + x) * 2);
      } else if (mode === 4) {
        const page = dispcnt & 0x10 ? 0xa000 : 0;
        const index = this.vram8(0x06000000 + page + y * SCREEN_WIDTH + x);
        if (index === 0) transparent = true;
        color = this.palette(index);
      } else {
        // Mode 5: 160x128, 16bpp.
        if (x >= 160 || y >= 128) continue;
        color = this.vram16(0x06000000 + (y * 160 + x) * 2);
      }
      if (transparent) continue;
      if (priority < this.priorities[x]) {
        this.priorities[x] = priority;
        this.layers[x] = 2;
        this.colors[x] = GbaPpu.COLOR_555[color & 0x7fff];
      }
    }
  }

  private renderObj(y: number): void {
    const dispcnt = this.dispcnt;
    if (!(dispcnt & 0x1000)) return;

    const oam = this.bus.oam;
    const oneDim = (dispcnt & 0x40) !== 0;
    const objWindowEnabled = (dispcnt & 0x8000) !== 0;

    for (let i = 0; i < 128; i++) {
      const o = i * 8;
      const attr0 = oam[o] | (oam[o + 1] << 8);
      const attr1 = oam[o + 2] | (oam[o + 3] << 8);
      const attr2 = oam[o + 4] | (oam[o + 5] << 8);

      const affine = (attr0 & 0x100) !== 0;
      const disabled = (attr0 & 0x200) !== 0 && !affine;
      if (disabled) continue;

      const objMode = (attr0 >> 10) & 0x3;
      const is8bpp = (attr0 & 0x2000) !== 0;
      const shape = attr0 >> 14;
      const size = attr1 >> 14;
      const dims = OBJ_SIZES[shape][size];
      const width = dims[0];
      const height = dims[1];
      if (width === 0) continue;

      const realHeight = affine && attr0 & 0x200 ? height * 2 : height;
      const realWidth = affine && attr0 & 0x200 ? width * 2 : width;

      const objY = (attr0 & 0xff) as number;
      let objX = attr1 & 0x1ff;
      if (objX >= 256) objX -= 512;

      if (y < objY || y >= objY + realHeight) continue;
      if (objX >= SCREEN_WIDTH || objX + realWidth <= 0) continue;

      const row = y - objY;
      const tileBase = attr2 & 0x3ff;
      const priority = (attr2 >> 10) & 0x3;
      const palNum = (attr2 >> 12) & 0xf;

      const isObjWindow = objMode === 2;
      if (isObjWindow && !objWindowEnabled) continue;

      const hflip = !affine && (attr1 & 0x1000) !== 0;
      const vflip = !affine && (attr1 & 0x2000) !== 0;

      let pa = 0x100;
      let pb = 0;
      let pc = 0;
      let pd = 0x100;
      if (affine) {
        const affineIndex = (attr1 >> 9) & 0x1f;
        const base = 6 + affineIndex * 32;
        pa = (oam[base] | (oam[base + 1] << 8)) << 16 >> 16;
        pb = (oam[base + 2] | (oam[base + 3] << 8)) << 16 >> 16;
        pc = (oam[base + 4] | (oam[base + 5] << 8)) << 16 >> 16;
        pd = (oam[base + 6] | (oam[base + 7] << 8)) << 16 >> 16;
      }

      for (let px = 0; px < realWidth; px++) {
        let sx = px;
        let sy = row;
        if (affine) {
          const cx = realWidth / 2;
          const cy = realHeight / 2;
          const dx = px - cx;
          const dy = row - cy;
          sx = ((pa * dx + pb * dy) >> 8) + width / 2;
          sy = ((pc * dx + pd * dy) >> 8) + height / 2;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        } else {
          if (hflip) sx = realWidth - 1 - px;
          if (vflip) sy = realHeight - 1 - row;
        }
        const screenX = objX + px;
        if (screenX < 0 || screenX >= SCREEN_WIDTH) continue;

        const tx = sx >> 3;
        const ty = sy >> 3;
        const tile = oneDim
          ? tileBase + ty * (width >> 3) + tx
          : tileBase + ty * 32 + tx;
        const tileAddr = 0x06010000 + tile * (is8bpp ? 64 : 32);
        const rowInTile = sy & 7;
        const colInTile = sx & 7;
        let colorIndex: number;
        if (is8bpp) {
          colorIndex = this.vram8(tileAddr + rowInTile * 8 + colInTile);
        } else {
          const byte = this.vram8(tileAddr + rowInTile * 4 + (colInTile >> 1));
          colorIndex = colInTile & 1 ? byte >> 4 : byte & 0xf;
          colorIndex += palNum * 16;
        }
        if (colorIndex === 0) continue;

        if (isObjWindow) {
          this.objWindow[screenX] = 1;
          continue;
        }

        // Lower OAM index wins ties, so only replace on a strictly better
        // priority (sprites are visited in ascending OAM order).
        if (this.objDrawn[screenX] && priority >= this.objPriorities[screenX]) continue;
        this.objDrawn[screenX] = 1;
        this.objPriorities[screenX] = priority;
        this.objColors[screenX] = this.palette(0x100 + colorIndex);
        this.semi[screenX] = objMode === 1 ? 1 : 0;
      }
    }
  }

  private composite(y: number): void {
    const fb = this.framebuffer;
    const base = y * SCREEN_WIDTH;
    const dispcnt = this.dispcnt;
    const blendMode = (this.bldcnt >> 6) & 0x3;
    const firstTarget = this.bldcnt & 0x3f;
    const secondTarget = (this.bldcnt >> 8) & 0x3f;
    const backdrop = this.palette(0);
    const eva = Math.min(16, this.bldalpha & 0x1f);
    const evb = Math.min(16, (this.bldalpha >> 8) & 0x1f);
    const evy = Math.min(16, this.bldy & 0x1f);
    const objEnabled = (dispcnt & 0x1000) !== 0;

    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const bgLayer = this.layers[x];
      const bgColor = this.colors[x];
      const bgPriority = this.priorities[x];
      const bgBit = bgLayer === 0xff ? 1 << 5 : 1 << bgLayer;
      const objVisible =
        objEnabled &&
        this.objDrawn[x] !== 0 &&
        (!this.windowsActive ||
          (this.windowLayers(
            this.winRegion[x] === 0 && this.objWindow[x] ? 3 : this.winRegion[x]
          ) & 0x10) !== 0);

      const objOnTop = objVisible && this.objPriorities[x] <= bgPriority;
      let color: number;
      let layerBit: number;
      let belowColor: number;
      let belowBit: number;
      let semi = false;

      if (objOnTop) {
        color = this.objColors[x];
        layerBit = 1 << 4;
        semi = this.semi[x] !== 0;
        belowColor = bgColor;
        belowBit = bgBit;
      } else {
        color = bgColor;
        layerBit = bgBit;
        belowColor = backdrop;
        belowBit = 1 << 5;
      }

      const effectsAllowed =
        !this.windowsActive ||
        (this.windowLayers(
          this.winRegion[x] === 0 && this.objWindow[x] ? 3 : this.winRegion[x]
        ) & 0x20) !== 0;

      if (blendMode !== 0 && effectsAllowed) {
        if (blendMode === 1 && (firstTarget & layerBit) !== 0) {
          const blendWithBelow =
            semi || ((secondTarget & belowBit) !== 0 && (secondTarget & layerBit) === 0);
          if (blendWithBelow) {
            const r = (((color & 0xff) * eva + (belowColor & 0xff) * evb) >> 4) & 0xff;
            const g =
              ((((color >> 8) & 0xff) * eva + ((belowColor >> 8) & 0xff) * evb) >> 4) & 0xff;
            const b =
              ((((color >> 16) & 0xff) * eva + ((belowColor >> 16) & 0xff) * evb) >> 4) & 0xff;
            color = (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;
          }
        } else if (blendMode === 2 && (firstTarget & layerBit) !== 0) {
          color = this.brighten(color, evy);
        } else if (blendMode === 3 && (firstTarget & layerBit) !== 0) {
          color = this.darken(color, evy);
        }
      }

      fb[base + x] = color;
    }
  }

  private brighten(color: number, amount: number): number {
    const r = (color & 0xff) + ((255 - (color & 0xff)) * amount) / 16;
    const g = ((color >> 8) & 0xff) + ((255 - ((color >> 8) & 0xff)) * amount) / 16;
    const b = ((color >> 16) & 0xff) + ((255 - ((color >> 16) & 0xff)) * amount) / 16;
    return (0xff000000 | ((r | 0) << 16) | ((g | 0) << 8) | (b | 0)) >>> 0;
  }

  private darken(color: number, amount: number): number {
    const r = ((color & 0xff) * (16 - amount)) / 16;
    const g = (((color >> 8) & 0xff) * (16 - amount)) / 16;
    const b = (((color >> 16) & 0xff) * (16 - amount)) / 16;
    return (0xff000000 | ((r | 0) << 16) | ((g | 0) << 8) | (b | 0)) >>> 0;
  }

  getFrameBuffer(): Uint32Array {
    return this.framebuffer;
  }

  reset(): void {
    this.dispcnt = 0;
    this.dispstat = 0;
    this.vcount = 0;
    this.bgcnt.fill(0);
    this.bghofs.fill(0);
    this.bgvofs.fill(0);
    this.bgpa.fill(0x100);
    this.bgpb.fill(0);
    this.bgpc.fill(0);
    this.bgpd.fill(0x100);
    this.bgx.fill(0);
    this.bgy.fill(0);
    this.win0h = 0;
    this.win1h = 0;
    this.win0v = 0;
    this.win1v = 0;
    this.winin = 0;
    this.winout = 0;
    this.mosaic = 0;
    this.bldcnt = 0;
    this.bldalpha = 0;
    this.bldy = 0;
    this.lineCycles = 0;
    this.line = 0;
    this.renderedThisLine = false;
    this.framebuffer.fill(0xffffffff);
  }

  getState(): Record<string, number | number[]> {
    return {
      dispcnt: this.dispcnt,
      dispstat: this.dispstat,
      vcount: this.vcount,
      bgcnt: Array.from(this.bgcnt),
      bghofs: Array.from(this.bghofs),
      bgvofs: Array.from(this.bgvofs),
      bgpa: Array.from(this.bgpa),
      bgpb: Array.from(this.bgpb),
      bgpc: Array.from(this.bgpc),
      bgpd: Array.from(this.bgpd),
      bgx: Array.from(this.bgx),
      bgy: Array.from(this.bgy),
      win0h: this.win0h,
      win1h: this.win1h,
      win0v: this.win0v,
      win1v: this.win1v,
      winin: this.winin,
      winout: this.winout,
      mosaic: this.mosaic,
      bldcnt: this.bldcnt,
      bldalpha: this.bldalpha,
      bldy: this.bldy,
      line: this.line,
      lineCycles: this.lineCycles,
      renderedThisLine: this.renderedThisLine ? 1 : 0,
    };
  }

  setState(state: any): void {
    this.dispcnt = state.dispcnt >>> 0;
    this.dispstat = state.dispstat >>> 0;
    this.vcount = state.vcount >>> 0;
    this.bgcnt.set(state.bgcnt);
    this.bghofs.set(state.bghofs);
    this.bgvofs.set(state.bgvofs);
    this.bgpa.set(state.bgpa);
    this.bgpb.set(state.bgpb);
    this.bgpc.set(state.bgpc);
    this.bgpd.set(state.bgpd);
    this.bgx.set(state.bgx);
    this.bgy.set(state.bgy);
    this.win0h = state.win0h;
    this.win1h = state.win1h;
    this.win0v = state.win0v;
    this.win1v = state.win1v;
    this.winin = state.winin;
    this.winout = state.winout;
    this.mosaic = state.mosaic;
    this.bldcnt = state.bldcnt;
    this.bldalpha = state.bldalpha;
    this.bldy = state.bldy;
    this.line = state.line;
    this.lineCycles = state.lineCycles;
    this.renderedThisLine = state.renderedThisLine === 1;
  }
}
