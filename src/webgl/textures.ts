// 纹理缓存：扫描图 Blob -> WebGLTexture（LRU），以及批注覆盖层纹理
import type { Annotation, PageImage } from '../types';
import { pageUvMatrix } from './gl';

interface CacheEntry {
  tex: WebGLTexture;
  rotation: 0 | 90 | 180 | 270;
  lastUsed: number;
}

const MAX_TEXTURES = 24;
const ANN_SIZE = 1024; // 批注层分辨率（方形，独立于原图比例）

export class TextureManager {
  private cache = new Map<string, CacheEntry>();
  private clock = 0;

  constructor(private gl: WebGL2RenderingContext) {}

  /** 取已上传纹理；未命中返回 null，由调用方走异步 loadImage */
  tryGet(imageId: string): { tex: WebGLTexture; uv: Float32Array } | null {
    const e = this.cache.get(imageId);
    if (!e) return null;
    e.lastUsed = ++this.clock;
    return { tex: e.tex, uv: pageUvMatrix(e.rotation) };
  }

  async loadImage(img: PageImage): Promise<{ tex: WebGLTexture; uv: Float32Array }> {
    const hit = this.cache.get(img.id);
    if (hit) {
      hit.lastUsed = ++this.clock;
      return { tex: hit.tex, uv: pageUvMatrix(hit.rotation) };
    }
    const bitmap = await createImageBitmap(img.blob);
    const tex = this.gl.createTexture()!;
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, bitmap);
    this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
    bitmap.close();
    this.cache.set(img.id, { tex, rotation: img.rotation, lastUsed: ++this.clock });
    this.evict();
    return { tex: tex, uv: pageUvMatrix(img.rotation) };
  }

  /** rotation 改变后重建该纹理的 UV 记录（纹理本身不变） */
  invalidate(imageId: string): void {
    this.cache.delete(imageId);
  }

  private evict(): void {
    while (this.cache.size > MAX_TEXTURES) {
      let oldestKey = '';
      let oldest = Infinity;
      for (const [k, e] of this.cache) {
        if (e.lastUsed < oldest) {
          oldest = e.lastUsed;
          oldestKey = k;
        }
      }
      const e = this.cache.get(oldestKey)!;
      this.gl.deleteTexture(e.tex);
      this.cache.delete(oldestKey);
    }
  }

  dispose(): void {
    for (const e of this.cache.values()) this.gl.deleteTexture(e.tex);
    this.cache.clear();
  }
}

/**
 * 批注覆盖层：每个物理面一张画布纹理。
 * 画布坐标即纹理坐标（左上原点，Y 向下），与叶面 vUV 直接对应，
 * 因此翻页网格如何卷曲，批注都会跟随同一套 UV 弯曲。
 */
export class AnnotationLayer {
  private canvas: HTMLCanvasElement;
  private tex: WebGLTexture;
  private gl: WebGL2RenderingContext;
  private empty = true;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.canvas = document.createElement('canvas');
    this.canvas.width = ANN_SIZE;
    this.canvas.height = ANN_SIZE;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ANN_SIZE, ANN_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  get texture(): WebGLTexture {
    return this.tex;
  }

  get isEmpty(): boolean {
    return this.empty;
  }

  redraw(annotations: Annotation[]): void {
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, ANN_SIZE, ANN_SIZE);
    this.empty = annotations.length === 0;
    for (const a of annotations) {
      const x = a.x * ANN_SIZE;
      const y = a.y * ANN_SIZE;
      const w = Math.max(8, a.width * ANN_SIZE);
      const h = Math.max(8, a.height * ANN_SIZE);
      // 半透明便签底
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = a.color;
      roundRect(ctx, x, y, w, h, 6);
      ctx.fill();
      ctx.globalAlpha = 1;
      // 边框
      ctx.strokeStyle = 'rgba(60,30,10,0.55)';
      ctx.lineWidth = 2;
      roundRect(ctx, x, y, w, h, 6);
      ctx.stroke();
      // 文字（自动缩放以贴合便签）
      const fontSize = Math.max(12, Math.min(28, h / Math.max(2, a.text.length / 6 + 1)));
      ctx.fillStyle = '#2b1a08';
      ctx.font = `${fontSize}px "KaiTi","STKaiti",serif`;
      ctx.textBaseline = 'top';
      wrapText(ctx, a.text, x + 6, y + 6, w - 12, fontSize * 1.15);
    }
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.tex);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.canvas);
  }

  dispose(): void {
    this.gl.deleteTexture(this.tex);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): void {
  let line = '';
  let yy = y;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = ch;
      yy += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy);
}
