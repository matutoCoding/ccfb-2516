// 翻页状态机 —— 并发安全的关键：
// 任何时刻只有一个叶在动（currentLeaf + progress），其余叶都是静止叠层。
// 连翻按钮只把目标叶号 targetLeaf 推远，动画串行追赶，物理上不可能出现两叶交叉或页序错乱。

export type FlipDir = 1 | -1; // +1 向右起翻 = 往后翻（右叠→左叠）；-1 反之

export interface ActiveFlip {
  leafIndex: number;
  dir: FlipDir;
  progress: number; // 0..1，0 = 起始侧平展，1 = 对侧平展
}

export interface DragInfo {
  active: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  velocity: number; // 像素/秒，带符号
  dir: FlipDir;
}

const FLICK_SPEED = 260; // px/s，超过即按抛投处理
const SETTLE_HALF = 0.5;

export class FlipController {
  /** 当前两叠之间的分界叶号：[0,leafCount)，左叠有 leaf 0..k-1，右叠有 leaf k..n-1 */
  k = 0;
  /** 用户最终想去的分界叶号 */
  target: number;
  active: ActiveFlip | null = null;
  drag: DragInfo = { active: false, startX: 0, startY: 0, lastX: 0, lastT: 0, velocity: 0, dir: 1 };
  /** 每次成功提交一条：叶号、方向、提交后的分界 k —— 用于验证连翻无跳页/重页 */
  history: Array<{ leafIndex: number; dir: FlipDir; k: number; t: number }> = [];

  private animFrom = 0;
  private animTo = 1;
  private animElapsed = 0;
  private animDuration = 650;
  private onCommit: (leafIndex: number, dir: FlipDir) => void;

  constructor(private leafCount: number, initial: number, onCommit: (leafIndex: number, dir: FlipDir) => void) {
    // n 个叶有 n+1 个装订位置：k=0 全在右叠，k=n 全在左叠
    this.k = Math.max(0, Math.min(initial, leafCount));
    this.target = this.k;
    this.onCommit = onCommit;
  }

  setDuration(ms: number): void {
    this.animDuration = ms;
  }

  get leafCountN(): number {
    return this.leafCount;
  }

  /** 按钮 / 键盘翻页：仅移动目标，动画循环负责串行追赶 */
  goto(targetLeaf: number): void {
    const t = Math.max(0, Math.min(targetLeaf, this.leafCount));
    this.target = t;
    this.kick();
  }

  next(): void {
    this.goto(this.target + 1);
  }

  prev(): void {
    this.goto(this.target - 1);
  }

  private kick(): void {
    if (this.active || this.drag.active || this.target === this.k) return;
    const dir: FlipDir = this.target > this.k ? 1 : -1;
    const leafIndex = dir === 1 ? this.k : this.k - 1;
    this.active = { leafIndex, dir, progress: dir === 1 ? 0 : 1 };
    this.animFrom = this.active.progress;
    this.animTo = dir === 1 ? 1 : 0;
    this.animElapsed = 0;
  }

  /** 指针按下：右半屏起后翻，左半屏起前翻；返回是否捕获 */
  pointerDown(x: number, y: number, halfWidth: number): boolean {
    if (this.active) return false;
    const goRightSide = x >= halfWidth;
    if (goRightSide && this.k >= this.leafCount) return false;
    if (!goRightSide && this.k <= 0) return false;
    const dir: FlipDir = goRightSide ? 1 : -1;
    const leafIndex = dir === 1 ? this.k : this.k - 1;
    this.active = { leafIndex, dir, progress: dir === 1 ? 0 : 1 };
    this.drag = { active: true, startX: x, startY: y, lastX: x, lastT: performance.now(), velocity: 0, dir };
    return true;
  }

  pointerMove(x: number, _y: number, halfWidth: number): void {
    if (!this.drag.active || !this.active) return;
    const now = performance.now();
    const dt = Math.max(1, now - this.drag.lastT) / 1000;
    const instV = (x - this.drag.lastX) / dt;
    // 平滑速度，避免单帧抖动
    this.drag.velocity = this.drag.velocity * 0.6 + instV * 0.4;
    this.drag.lastX = x;
    this.drag.lastT = now;
    const dx = x - this.drag.startX;
    if (this.drag.dir === 1) {
      // 向右起翻：向左拖 → 进度增加
      this.active.progress = Math.max(0, Math.min(1, -dx / halfWidth));
    } else {
      // 向左起翻：向右拖 → 进度减小（1→0）
      this.active.progress = Math.max(0, Math.min(1, 1 - dx / halfWidth));
    }
  }

  pointerUp(): void {
    if (!this.drag.active || !this.active) return;
    const flip = this.active;
    const v = this.drag.velocity;
    let finish: boolean;
    if (Math.abs(v) > FLICK_SPEED) {
      // 抛投：速度方向决定去留
      finish = flip.dir === 1 ? v < 0 : v > 0;
    } else {
      finish = flip.progress >= SETTLE_HALF;
    }
    this.drag.active = false;
    this.animFrom = flip.progress;
    this.animTo = finish ? (flip.dir === 1 ? 1 : 0) : flip.dir === 1 ? 0 : 1;
    this.animElapsed = 0;
    // 让目标与本次手势结果一致：成页则把目标推到相邻装订位，回弹则收回当前位
    if (finish) {
      this.target = Math.max(0, Math.min(this.k + flip.dir, this.leafCount));
    } else {
      this.target = this.k;
    }
  }

  /** 每帧推进；dt 毫秒 */
  update(dt: number): void {
    if (!this.active || this.drag.active) return;
    this.animElapsed += dt;
    const t = Math.min(1, this.animElapsed / this.animDuration);
    const eased = easeInOutCubic(t);
    this.active.progress = this.animFrom + (this.animTo - this.animFrom) * eased;
    if (t >= 1) {
      const done = this.active;
      const reachedEnd = done.dir === 1 ? this.animTo === 1 : this.animTo === 0;
      this.active = null;
      if (reachedEnd) {
        // 提交：分界叶号移动，物理上一次只跨一个叶。
        // 注意不能重置 target —— 连翻时 target 在远处，kick() 靠它接续后续叶。
        this.k = Math.max(0, Math.min(this.k + done.dir, this.leafCount));
        this.history.push({ leafIndex: done.leafIndex, dir: done.dir, k: this.k, t: performance.now() });
        this.onCommit(done.leafIndex, done.dir);
      }
      this.kick(); // 若 target 仍在远处，立刻接续下一叶（连翻队列）
    }
  }

  /** 当前用于渲染的叶状态 */
  renderState(): { k: number; active: ActiveFlip | null } {
    return { k: this.k, active: this.active };
  }
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
