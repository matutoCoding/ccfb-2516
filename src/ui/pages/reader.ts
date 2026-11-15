// 阅读页：WebGL 书册 + 手势/键盘交互 + 缩放平移 + 截图
import { library, settingsStore } from '../../services/store';
import { clamp, clearNode, downloadBlob, h } from '../../utils/dom';
import { go, onDispose } from '../router';
import { BookRenderer } from '../../webgl/BookRenderer';
import { toast } from '../components/common';

type GestureMode = 'flip' | 'pan';

export function renderReader(root: HTMLElement, bookId: string): () => void {
  const book = library.getBook(bookId);
  if (!book) {
    root.replaceChildren(h('div', { className: 'empty-tip' }, ['书目不存在，返回书库重新选择']));
    return () => undefined;
  }

  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const stage = h('div', { className: 'reader-stage' }, [canvas]);
  let renderer: BookRenderer;
  try {
    renderer = new BookRenderer(canvas, book, settingsStore.get(), library.annotationsFor(bookId), (k) => {
      void library.saveProgress(bookId, k);
      updateInfo();
    });
  } catch (err) {
    root.replaceChildren(h('div', { className: 'empty-tip' }, [(err as Error).message]));
    return () => undefined;
  }

  let mode: GestureMode = 'flip';
  let panning = false;
  let lastPx = 0;
  let lastPy = 0;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;

  // ---- 指针交互 ----
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // 双指 → 捏合缩放，取消翻页
      pinchDist = distTwo(pointers);
      panning = false;
      return;
    }
    if (mode === 'pan' || e.button === 1 || e.shiftKey) {
      panning = true;
      lastPx = e.clientX;
      lastPy = e.clientY;
      canvas.classList.add('dragging');
    } else {
      renderer.pointerDown(e.clientX, e.clientY);
      canvas.classList.toggle('dragging', renderer.isDragging);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const d = distTwo(pointers);
      if (pinchDist > 0) renderer.zoomBy(d / pinchDist);
      pinchDist = d;
      return;
    }
    if (panning) {
      const rect = canvas.getBoundingClientRect();
      const scaleWorld = 2 / rect.width;
      renderer.panBy((e.clientX - lastPx) * scaleWorld, -(e.clientY - lastPy) * scaleWorld);
      lastPx = e.clientX;
      lastPy = e.clientY;
    } else {
      renderer.pointerMove(e.clientX, e.clientY);
      canvas.classList.toggle('dragging', renderer.isDragging);
    }
  });

  const endPointer = (e: PointerEvent) => {
    if (pointers.has(e.pointerId)) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
    }
    if (panning) {
      panning = false;
      canvas.classList.remove('dragging');
    } else {
      renderer.pointerUp();
      canvas.classList.remove('dragging');
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // 滚轮：缩放（Ctrl/普通）或平移
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const w = renderer.screenToWorld(e.clientX, e.clientY);
      void rect;
      renderer.zoomBy(Math.exp(-e.deltaY * 0.0012), w.x, w.y);
    } else {
      const rect = canvas.getBoundingClientRect();
      renderer.panBy(0, e.deltaY * (2 / rect.height) * 0.6);
    }
  }, { passive: false });

  // ---- 键盘：连翻压力测试的入口 ----
  const onKey = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowLeft':
      case 'PageUp':
        renderer.prev();
        e.preventDefault();
        break;
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
        renderer.next();
        e.preventDefault();
        break;
      case 'Home':
        renderer.goto(0);
        break;
      case 'End':
        renderer.goto(renderer.leafCount);
        break;
      case 'r':
      case 'R':
        renderer.fitView();
        break;
    }
  };
  window.addEventListener('keydown', onKey);

  // ---- 工具条 ----
  const info = h('div', { className: 'page-info' });
  function updateInfo() {
    info.textContent = `第 ${renderer.k} / ${renderer.leafCount} 叠`;
  }
  updateInfo();

  const modeBtn = h('button', {
    onclick: () => {
      mode = mode === 'flip' ? 'pan' : 'flip';
      modeBtn.textContent = mode === 'flip' ? '手势：翻页' : '手势：平移';
      toast(mode === 'flip' ? '拖动书页即可翻页' : '拖动平移，滚轮缩放');
    },
  }, ['手势：翻页']);

  const jumpInput = h('input', {
    type: 'number',
    min: '0',
    max: String(renderer.leafCount),
    style: 'width:84px',
    placeholder: '页码',
  }) as HTMLInputElement;

  const bar = h('div', { className: 'reader-bar' }, [
    h('button', { onclick: () => go('library') }, ['← 书库']),
    h('button', { onclick: () => go(`editor/${encodeURIComponent(bookId)}`) }, ['书页编辑']),
    h('button', { onclick: () => go(`annotations/${encodeURIComponent(bookId)}`) }, ['批注']),
    h('div', { className: 'spacer' }),
    h('button', { onclick: () => renderer.prev() }, ['◀ 前翻']),
    info,
    h('button', { className: 'primary', onclick: () => renderer.next() }, ['后翻 ▶']),
    h('div', { className: 'spacer' }),
    jumpInput,
    h('button', { onclick: () => renderer.goto(clamp(Number(jumpInput.value) || 0, 0, renderer.leafCount)) }, ['跳转']),
    modeBtn,
    h('button', { onclick: () => renderer.zoomBy(1.2) }, ['放大']),
    h('button', { onclick: () => renderer.zoomBy(1 / 1.2) }, ['缩小']),
    h('button', { onclick: () => renderer.fitView() }, ['复位']),
    h('button', { onclick: () => doCapture() }, ['截图']),
    h('button', { onclick: () => go('settings') }, ['设置']),
  ]);

  const bookRef = book;
  async function doCapture() {
    const label = `叶 ${renderer.k + 1} / ${renderer.leafCount}`;
    const blob = await renderer.captureAsync(bookRef.title, label);
    downloadBlob(blob, `${bookRef.title}-${label.replace(/[\\s/]/g, '')}.png`);
    toast('截图已保存（含书名与页码）');
  }

  const hint = h('div', {
    style: 'position:absolute;left:50%;top:14px;transform:translateX(-50%);font-size:12px;color:#b9a37c;background:rgba(15,10,6,.55);padding:6px 14px;border-radius:20px;pointer-events:none;letter-spacing:1px;',
  }, ['拖页跟手翻 · 松手按速度成页或回弹 · ←→ 键连翻 · Shift+拖动平移 · Ctrl+滚轮缩放']);
  stage.append(hint);

  const layout = h('div', { className: 'reader-layout' }, [stage, bar]);
  root.replaceChildren(layout);

  // 设置变化实时下发
  const offSettings = settingsStore.changed.on((s) => renderer.setSettings(s));
  const offLibrary = library.changed.on(() => renderer.setAnnotations(library.annotationsFor(bookId)));

  onDispose(root, () => {
    window.removeEventListener('keydown', onKey);
    offSettings();
    offLibrary();
    renderer.dispose();
  });

  return () => undefined;
}

function distTwo(map: Map<number, { x: number; y: number }>): number {
  const [a, b] = [...map.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}
