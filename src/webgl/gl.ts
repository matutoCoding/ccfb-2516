// WebGL2 轻量封装：编译、网格、uniform 工具
export class GlError extends Error {}

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new GlError(`程序链接失败: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new GlError(`着色器编译失败: ${gl.getShaderInfoLog(sh)}\n${src}`);
  }
  return sh;
}

export interface Mesh {
  vao: WebGLVertexArrayObject;
  count: number;
}

/** 单属性 vec2 网格：rows×cols 规则面片 */
export function createGridMesh(gl: WebGL2RenderingContext, prog: WebGLProgram, attrName: string, cols = 48, rows = 32): Mesh {
  const verts: number[] = [];
  const idx: number[] = [];
  for (let y = 0; y <= rows; y++) {
    for (let x = 0; x <= cols; x++) verts.push(x / cols, y / rows);
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = y * (cols + 1) + x;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      // 以 (x 增大, y 增大) 为正面（CCW）
      idx.push(a, c, b, b, c, d);
    }
  }
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, attrName);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const ibo = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: idx.length };
}

/** 全屏三角片（两个三角形，属性即 NDC） */
export function createQuadMesh(gl: WebGL2RenderingContext, prog: WebGLProgram, attrName: string): Mesh {
  const data = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, attrName);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return { vao, count: 3 };
}

export class Uniforms {
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(private gl: WebGL2RenderingContext, private prog: WebGLProgram) {}
  loc(name: string): WebGLUniformLocation | null {
    let l = this.locs.get(name);
    if (l === undefined && !this.locs.has(name)) {
      l = this.gl.getUniformLocation(this.prog, name);
      this.locs.set(name, l);
    }
    return l ?? null;
  }
  set1f(name: string, v: number) { this.gl.uniform1f(this.loc(name), v); }
  set2f(name: string, x: number, y: number) { this.gl.uniform2f(this.loc(name), x, y); }
  set4f(name: string, a: number, b: number, c: number, d: number) { this.gl.uniform4f(this.loc(name), a, b, c, d); }
  set1i(name: string, v: number) { this.gl.uniform1i(this.loc(name), v); }
  setMat3(name: string, m: Float32Array | number[]) { this.gl.uniformMatrix3fv(this.loc(name), false, m); }
}

/**
 * 构造叶面 UV 变换。
 * 顶点着色器已把叶面 vUV 翻成 GL 纹理坐标（v 向上），这里只负责旋转。
 * 输入纹理用 UNPACK_FLIP_Y 上传，GL 坐标 (0,0) 对应图像左下角。
 * 输出矩阵作用于 vUV（x 装订边→书口，y 天头→地脚，左上原点）。
 */
export function pageUvMatrix(rotation: 0 | 90 | 180 | 270): Float32Array {
  const rot: Record<number, Float32Array> = {
    0: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    90: new Float32Array([0, 1, 0, -1, 0, 1, 0, 0, 1]),
    180: new Float32Array([-1, 0, 1, 0, -1, 1, 0, 0, 1]),
    270: new Float32Array([0, -1, 1, 1, 0, 0, 0, 0, 1]),
  };
  return new Float32Array(rot[rotation]);
}

export function createEndpaperTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 720;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 512, 720);
  grad.addColorStop(0, '#e9ddc2');
  grad.addColorStop(0.5, '#e2d3b2');
  grad.addColorStop(1, '#d8c6a0');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 512, 720);
  // 细纤维噪点
  const img = ctx.getImageData(0, 0, 512, 720);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n * 0.7;
  }
  ctx.putImageData(img, 0, 0);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
