// 古籍书册渲染器：双叠 + 单动叶的 WebGL2 场景
import type { AgingParams, Annotation, Book, ReaderSettings } from '../types';
import { Uniforms, createEndpaperTexture, createGridMesh, createProgram, createQuadMesh, type Mesh } from './gl';
import { FlipController } from './flip';
import { AnnotationLayer, TextureManager } from './textures';
import { BG_FRAG, BG_VERT, LEAF_FRAG, LEAF_VERT } from './shaders';
import { db } from '../services/idb';
import { clamp } from '../utils/dom';
import { leafPosition, type LeafGeomParams } from './leafMath';

interface SideTex {
  tex: WebGLTexture | null;
  uv: Float32Array;
}

const EMPTY_UV = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export class BookRenderer {
  private gl: WebGL2RenderingContext;
  private leafProg: WebGLProgram;
  private bgProg: WebGLProgram;
  private leafMesh: Mesh;
  private bgMesh: Mesh;
  private uLeaf: Uniforms;
  private uBg: Uniforms;
  private texMgr: TextureManager;
  private endpaper: WebGLTexture;
  private emptyAnn: WebGLTexture;

  private flip: FlipController;
  private annotations: Annotation[] = [];
  private annLayers = new Map<string, AnnotationLayer>();
  private pendingLoads = new Set<string>();

  // 相机：正交（世界坐标直接映射 NDC）
  private scale = 1;
  private panX = 0;
  private panY = 0;
  private baseScale = 1;

  // 书页世界尺寸
  readonly pageW = 1.35;
  readonly pageH = 2.0;
  readonly gap = 0.05;
  private r0 = 0.34;
  /** 书本俯仰角（弧度）：让正交视角下也能看到纸张卷曲的立体高度 */
  readonly tilt = 0.42;

  private settings: ReaderSettings;
  private bookAging: Partial<AgingParams> | undefined;
  private raf = 0;
  private lastT = 0;
  private destroyed = false;
  private needRedraw = true;
  private resizeObserver: ResizeObserver;
  private onCommitCb: (k: number) => void;

  constructor(
    private canvas: HTMLCanvasElement,
    private book: Book,
    settings: ReaderSettings,
    annotations: Annotation[],
    onCommit: (k: number) => void,
  ) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.settings = settings;
    this.bookAging = book.aging;
    this.annotations = annotations;
    this.onCommitCb = onCommit;

    this.leafProg = createProgram(gl, LEAF_VERT, LEAF_FRAG);
    this.bgProg = createProgram(gl, BG_VERT, BG_FRAG);
    this.uLeaf = new Uniforms(gl, this.leafProg);
    this.uBg = new Uniforms(gl, this.bgProg);
    this.leafMesh = createGridMesh(gl, this.leafProg, 'aUV', 56, 36);
    this.bgMesh = createQuadMesh(gl, this.bgProg, 'aPos');
    this.texMgr = new TextureManager(gl);
    this.endpaper = createEndpaperTexture(gl);
    this.emptyAnn = createTransparentTexture(gl);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.clearDepth(1);

    this.flip = new FlipController(book.leafImageIds.length, book.progress, () => {
      this.onCommitCb(this.flip.k);
    });
    this.flip.setDuration(settings.flipDuration);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.needRedraw = true;
    });
    this.resizeObserver.observe(canvas);

    this.resize();
    this.fitView();
    this.prefetch();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  // ---------- 对外控制 ----------

  next(): void {
    this.flip.next();
    this.needRedraw = true;
  }
  prev(): void {
    this.flip.prev();
    this.needRedraw = true;
  }
  goto(k: number): void {
    this.flip.goto(k);
    this.needRedraw = true;
  }
  get k(): number {
    return this.flip.k;
  }
  get leafCount(): number {
    return this.book.leafImageIds.length;
  }
  get isDragging(): boolean {
    return this.flip.drag.active;
  }

  setSettings(s: ReaderSettings): void {
    this.settings = s;
    this.flip.setDuration(s.flipDuration);
    this.needRedraw = true;
  }

  setAnnotations(list: Annotation[]): void {
    this.annotations = list;
    // 重绘受影响的批注层
    const keys = new Set(list.map((a) => `${a.leafIndex}:${a.side}`));
    for (const [key, layer] of this.annLayers) {
      if (keys.has(key)) {
        layer.redraw(list.filter((a) => `${a.leafIndex}:${a.side}` === key));
      }
    }
    this.needRedraw = true;
  }

  /** 旋转等元数据变化后丢弃纹理缓存 */
  invalidateImage(imageId: string): void {
    this.texMgr.invalidate(imageId);
    this.needRedraw = true;
  }

  // ---------- 相机 ----------

  fitView(): void {
    const bookW = (this.pageW + this.gap) * 2;
    // 俯仰后视觉高度 = 页高 * cos(tilt)，再给卷曲峰留余量
    const bookH = this.pageH * Math.cos(this.tilt) * 1.18;
    const sx = 2 / bookW;
    const sy = 2 / bookH;
    this.baseScale = Math.min(sx, sy) * 0.92;
    this.scale = this.baseScale;
    this.panX = 0;
    this.panY = 0;
    this.needRedraw = true;
  }

  zoomBy(factor: number, cx = 0, cy = 0): void {
    const ns = clamp(this.scale * factor, this.baseScale * 0.5, this.baseScale * 8);
    // 以光标为锚点缩放
    this.panX = cx - (cx - this.panX) * (ns / this.scale);
    this.panY = cy - (cy - this.panY) * (ns / this.scale);
    this.scale = ns;
    this.needRedraw = true;
  }

  panBy(dxWorld: number, dyWorld: number): void {
    this.panX += dxWorld;
    this.panY += dyWorld;
    this.needRedraw = true;
  }

  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
    const sx = (nx - this.panX) / this.scale;
    // 屏幕 y 是俯仰后的桌面 y（z=0 平面），反算世界 y
    const sy = (ny - this.panY) / this.scale / Math.cos(this.tilt);
    return { x: sx, y: sy };
  }
  // ---------- 指针交互（翻页拖动） ----------

  pointerDown(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (this.flip.pointerDown(clientX, clientY, rect.width / 2)) {
      this.needRedraw = true;
      return true;
    }
    return false;
  }

  pointerMove(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.flip.pointerMove(clientX, clientY, rect.width / 2);
    this.needRedraw = true;
  }

  pointerUp(): void {
    this.flip.pointerUp();
    this.needRedraw = true;
  }

  /** 批注拾取：返回动叶或静止叠层上命中的叶面位置 */
  pickAnnotation(clientX: number, clientY: number): { leafIndex: number; side: 'recto' | 'verso'; u: number; v: number } | null {
    const w = this.screenToWorld(clientX, clientY);
    const { k, active } = this.flip.renderState();
    if (active) {
      const gp: LeafGeomParams = {
        progress: active.progress,
        dir: active.dir,
        pageW: this.pageW,
        pageH: this.pageH,
        gap: this.gap,
        r0: this.r0,
      };
      // 仅在弧面段附近允许拾取动叶
      const u = invertU(w.x, gp);
      if (u !== null) {
        const v = clamp(0.5 - w.y / this.pageH, 0, 1);
        const side: 'recto' | 'verso' = active.dir === 1 ? 'recto' : 'verso';
        return { leafIndex: active.leafIndex, side, u, v };
      }
    }
    // 静止叠层：右叠 recto，左叠 verso
    if (w.x > 0 && k < this.leafCount) {
      const u = clamp((w.x - this.gap) / this.pageW, 0, 1);
      const v = clamp(0.5 - w.y / this.pageH, 0, 1);
      if (v >= 0 && v <= 1 && w.y >= -this.pageH / 2 && w.y <= this.pageH / 2) {
        return { leafIndex: k, side: 'recto', u, v };
      }
    }
    if (w.x < 0 && k > 0) {
      const u = clamp((-w.x - this.gap) / this.pageW, 0, 1);
      const v = clamp(0.5 - w.y / this.pageH, 0, 1);
      if (v >= 0 && v <= 1) return { leafIndex: k - 1, side: 'verso', u, v };
    }
    return null;
  }

  // ---------- 截图 ----------

  /** 截图：readPixels 离屏读回，加书名/页码题签后导出 PNG */
  captureAsync(title: string, pageLabel: string): Promise<Blob> {
    const gl = this.gl;
    this.drawFrame();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h + 64;
    const ctx = out.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      const src = (h - 1 - row) * w * 4;
      img.data.set(pixels.subarray(src, src + w * 4), row * w * 4);
    }
    ctx.putImageData(img, 0, 64);
    ctx.fillStyle = '#2b2118';
    ctx.fillRect(0, 0, w, 64);
    ctx.fillStyle = '#e8dcc2';
    ctx.font = '26px "KaiTi","STKaiti",serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`《${title}》`, 24, 32);
    ctx.textAlign = 'right';
    ctx.fillText(pageLabel, w - 24, 32);
    return new Promise<Blob>((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('截图编码失败'))), 'image/png'));
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(64, Math.round(rect.width * dpr));
    const h = Math.max(64, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
      this.needRedraw = true;
    }
  }

  dispose(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.texMgr.dispose();
    for (const l of this.annLayers.values()) l.dispose();
    this.annLayers.clear();
    this.gl.deleteTexture(this.endpaper);
    this.gl.deleteTexture(this.emptyAnn);
    this.gl.deleteProgram(this.leafProg);
    this.gl.deleteProgram(this.bgProg);
  }

  // ---------- 内部实现 ----------

  private cameraMatrix(): Float32Array {
    return new Float32Array([this.scale, 0, 0, 0, this.scale, 0, this.panX, this.panY, 1]);
  }

  private agingVec(): [number, number, number, number] {
    const a = { ...this.settings.aging, ...this.bookAging };
    return [a.yellowing, a.wormhole, a.mildew, a.overall];
  }

  private async prefetch(): Promise<void> {
    const ids = this.book.leafImageIds;
    const near = new Set<string>();
    const { k } = this.flip.renderState();
    for (let i = Math.max(0, k - 1); i <= Math.min(ids.length - 1, k + 1); i++) near.add(ids[i]);
    for (const id of near) await this.loadTexture(id);
    this.needRedraw = true;
  }

  private async loadTexture(imageId: string): Promise<void> {
    if (this.texMgr.tryGet(imageId) || this.pendingLoads.has(imageId)) return;
    this.pendingLoads.add(imageId);
    try {
      const img = await db.getImage(imageId);
      if (img && !this.destroyed) await this.texMgr.loadImage(img);
    } finally {
      this.pendingLoads.delete(imageId);
      this.needRedraw = true;
    }
  }

  private sideTexture(leafIndex: number, side: 'recto' | 'verso'): SideTex {
    if (leafIndex < 0 || leafIndex >= this.leafCount) return { tex: this.endpaper, uv: EMPTY_UV };
    const imgId = this.book.leafImageIds[leafIndex];
    void side;
    const hit = this.texMgr.tryGet(imgId);
    if (!hit) {
      void this.loadTexture(imgId);
      return { tex: this.endpaper, uv: EMPTY_UV };
    }
    return { tex: hit.tex, uv: hit.uv };
  }

  private annLayerFor(leafIndex: number, side: 'recto' | 'verso'): AnnotationLayer {
    const key = `${leafIndex}:${side}`;
    let layer = this.annLayers.get(key);
    if (!layer) {
      layer = new AnnotationLayer(this.gl);
      layer.redraw(this.annotations.filter((a) => a.leafIndex === leafIndex && a.side === side));
      this.annLayers.set(key, layer);
    }
    return layer;
  }

  private loop(t: number): void {
    if (this.destroyed) return;
    // 钳制 dt：页面从后台切回时首帧间隔可能达数秒，避免动画状态跳变
    const dt = this.lastT ? Math.min(64, t - this.lastT) : 16;
    this.lastT = t;
    const before = this.flip.active?.progress ?? -1;
    this.flip.update(dt);
    const after = this.flip.active?.progress ?? -1;
    if (before !== after) this.needRedraw = true;
    if (this.needRedraw || this.flip.active) {
      this.drawFrame();
      this.needRedraw = false;
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  private drawFrame(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.08, 0.07, 0.06, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.drawBackground();

    const { k, active } = this.flip.renderState();
    // 绘制顺序：左叠 → 右叠 → 动叶（深度测试保证弧面遮挡正确）
    this.drawStack(k, 'left');
    this.drawStack(k, 'right');
    if (active) this.drawActiveLeaf(active);
  }

  private drawBackground(): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.bgProg);
    gl.bindVertexArray(this.bgMesh.vao);
    this.uBg.set1i('uLighting', this.settings.lighting === 'lamp' ? 1 : 0);
    this.uBg.set2f('uLampNdc', this.lampNdc()[0], this.lampNdc()[1]);
    gl.drawArrays(gl.TRIANGLES, 0, this.bgMesh.count);
    gl.enable(gl.DEPTH_TEST);
  }

  private lampNdc(): [number, number] {
    // 设置里的灯位是屏幕归一化坐标，换算到 NDC
    return [this.settings.lampX * 2 - 1, -(this.settings.lampY * 2 - 1)];
  }

  private commonLeafUniforms(lift: number): void {
    const u = this.uLeaf;
    u.set1f('uPageW', this.pageW);
    u.set1f('uPageH', this.pageH);
    u.set1f('uGap', this.gap);
    u.set1f('uR0', this.r0);
    u.set1f('uLift', lift);
    u.set1f('uTilt', this.tilt);
    u.setMat3('uCamera', this.cameraMatrix());
    const ag = this.agingVec();
    u.set4f('uAging', ag[0], ag[1], ag[2], ag[3]);
    u.set1f('uTranslucency', this.settings.translucency);
    u.set1i('uLighting', this.settings.lighting === 'lamp' ? 1 : 0);
    const lampWorld = this.screenToWorld(this.settings.lampX * this.canvas.clientWidth, this.settings.lampY * this.canvas.clientHeight);
    u.set2f('uLampPos', lampWorld.x, lampWorld.y);
    u.set1f('uVignette', this.settings.vignette);
    u.set1f('uStackDepth', 1);
    u.set2f('uBookSize', (this.pageW + this.gap) * 2, this.pageH);
  }

  private bindLeafTextures(leafIndex: number): void {
    const gl = this.gl;
    const u = this.uLeaf;
    const front = this.sideTexture(leafIndex, 'recto');
    const back = this.sideTexture(leafIndex, 'verso');
    const annF = this.annLayerFor(leafIndex, 'recto');
    const annB = this.annLayerFor(leafIndex, 'verso');

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, front.tex ?? this.endpaper);
    u.set1i('uFrontTex', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, back.tex ?? this.endpaper);
    u.set1i('uBackTex', 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, annF.isEmpty ? this.emptyAnn : annF.texture);
    u.set1i('uFrontAnn', 2);
    u.set1f('uHasAnnFront', annF.isEmpty ? 0 : 1);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, annB.isEmpty ? this.emptyAnn : annB.texture);
    u.set1i('uBackAnn', 3);
    u.set1f('uHasAnnBack', annB.isEmpty ? 0 : 1);
    u.setMat3('uFrontUv', front.uv);
    u.setMat3('uBackUv', back.uv);
    gl.activeTexture(gl.TEXTURE0);
  }

  private drawStack(k: number, side: 'left' | 'right'): void {
    const gl = this.gl;
    gl.useProgram(this.leafProg);
    gl.bindVertexArray(this.leafMesh.vao);
    if (side === 'left') {
      // 左叠顶页 = leaf k-1 的 verso，progress=1（镜像到左侧）
      const leafIndex = k - 1;
      if (leafIndex < 0) return;
      const depth = k; // 左叠叶数
      this.commonLeafUniforms(0.002 * Math.max(1, depth));
      this.uLeaf.set1f('uStackDepth', depth);
      this.uLeaf.set1f('uProgress', 1);
      this.uLeaf.set1f('uDir', -1);
      this.bindLeafTextures(leafIndex);
      gl.drawElements(gl.TRIANGLES, this.leafMesh.count, gl.UNSIGNED_SHORT, 0);
    } else {
      const leafIndex = k;
      if (leafIndex >= this.leafCount) return;
      const depth = this.leafCount - k; // 右叠叶数
      this.commonLeafUniforms(0.002 * Math.max(1, depth));
      this.uLeaf.set1f('uStackDepth', depth);
      this.uLeaf.set1f('uProgress', 0);
      this.uLeaf.set1f('uDir', 1);
      this.bindLeafTextures(leafIndex);
      gl.drawElements(gl.TRIANGLES, this.leafMesh.count, gl.UNSIGNED_SHORT, 0);
    }
  }

  private drawActiveLeaf(active: { leafIndex: number; progress: number; dir: 1 | -1 }): void {
    const gl = this.gl;
    gl.useProgram(this.leafProg);
    gl.bindVertexArray(this.leafMesh.vao);
    this.commonLeafUniforms(0.02);
    this.uLeaf.set1f('uStackDepth', 1);
    this.uLeaf.set1f('uProgress', active.progress);
    this.uLeaf.set1f('uDir', active.dir);
    this.bindLeafTextures(active.leafIndex);
    gl.drawElements(gl.TRIANGLES, this.leafMesh.count, gl.UNSIGNED_SHORT, 0);
  }
}

function createTransparentTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** 世界 x 反演动叶 u（数值法），不在弧面邻域返回 null */
function invertU(worldX: number, gp: LeafGeomParams): number | null {
  let best: { u: number; d: number } | null = null;
  const STEPS = 160;
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS;
    const p = leafPosition(u, 0.5, gp);
    const d = Math.abs(p.x - worldX);
    if (!best || d < best.d) best = { u, d };
  }
  // 阈值约为页宽的 2%
  if (best && best.d < gp.pageW * 0.02) return best.u;
  return null;
}
