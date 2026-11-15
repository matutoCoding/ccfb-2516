// 与 shaders.ts 中 deformLeaf 严格同步的 TypeScript 版本。
// 用途：批注拾取时把屏幕坐标反算为叶面归一化 UV（数值反演，无需解析求逆）。
import type { FlipDir } from './flip';

export interface LeafGeomParams {
  progress: number;
  dir: FlipDir;
  pageW: number;
  pageH: number;
  gap: number;
  r0: number;
}

const PI = Math.PI;
const EPS_R = 0.004;

export interface CurlVars {
  R: number;
  phi: number;
  b: number;
  lf: number;
}

export function curlVars(progress: number, pageW: number, r0: number): CurlVars {
  const p = Math.max(0, Math.min(1, progress));
  if (p <= 0.5) {
    const q = p * 2;
    const R = r0 * (1 - 0.25 * q);
    return { R, phi: PI * q, b: pageW - R * PI * q, lf: 0 };
  }
  const q = p * 2 - 1;
  const rStart = r0 * 0.75;
  const R = rStart + (EPS_R - rStart) * q * q;
  const b0 = pageW - PI * rStart;
  const b = b0 * (1 - q);
  return { R, phi: PI, b, lf: pageW - b - PI * R };
}

/** 叶面参数 (u,v) → 以书脊为原点的世界坐标 */
export function leafPosition(u: number, v: number, gp: LeafGeomParams): { x: number; y: number; z: number } {
  const W = gp.pageW;
  const d = u * W;
  const { R, phi, b, lf } = curlVars(gp.progress, W, gp.r0);
  let X: number, Z: number;
  if (d <= b) {
    X = gp.gap + d;
    Z = 0;
  } else if (d <= b + R * phi) {
    const theta = (d - b) / Math.max(R, 1e-4);
    const cx = gp.gap + b - R;
    X = cx + R * Math.sin(theta);
    Z = R - R * Math.cos(theta);
  } else {
    X = gp.gap + b - 2 * R - (d - b - R * phi);
    Z = 0;
    void lf;
  }
  return {
    x: gp.dir * X,
    y: (0.5 - v) * gp.pageH,
    z: Z,
  };
}

/**
 * 屏幕世界坐标 → 最近叶面参数。沿弧长采样 220 段找最近点，
 * 命中时返回 {u,v,dist}，dist 为世界单位残差。
 */
export function pickLeaf(
  worldX: number,
  worldY: number,
  gp: LeafGeomParams,
): { u: number; v: number; dist: number } | null {
  const STEPS = 220;
  let best: { u: number; v: number; dist: number } | null = null;
  for (let i = 0; i <= STEPS; i++) {
    const u = i / STEPS;
    const pt = leafPosition(u, 0.5, gp);
    const dx = pt.x - worldX;
    const dist2 = dx * dx;
    if (!best || dist2 < best.dist * best.dist) {
      best = { u, v: 0.5, dist: Math.sqrt(dist2) };
    }
  }
  if (!best) return null;
  // v 由 y 线性反算
  best.v = Math.max(0, Math.min(1, 0.5 - worldY / gp.pageH));
  // 若最近点落在平展段之外（y 超出页高），调用方自行判定阈值
  return best;
}
