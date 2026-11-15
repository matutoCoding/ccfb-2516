// 批注页：在渲染出的纸面上点选落点，批注随页弯曲（与阅读页同一渲染器）
import { library } from '../../services/store';
import { settingsStore } from '../../services/store';
import { clearNode, h } from '../../utils/dom';
import { go, onDispose } from '../router';
import { BookRenderer } from '../../webgl/BookRenderer';
import { openModal, toast } from '../components/common';
import type { Annotation } from '../../types';

const COLORS = ['#e8c96a', '#d98a78', '#8fb59b', '#9fb4d9', '#c9a3d9'];

export function renderAnnotations(root: HTMLElement, bookId: string): () => void {
  const book = library.getBook(bookId);
  if (!book) {
    root.replaceChildren(h('div', { className: 'empty-tip' }, ['书目不存在']));
    return () => undefined;
  }

  const canvas = h('canvas', {}) as HTMLCanvasElement;
  const stage = h('div', { className: 'ann-stage' }, [canvas]);
  let renderer: BookRenderer;
  try {
    renderer = new BookRenderer(canvas, book, settingsStore.get(), library.annotationsFor(bookId), (k) => {
      void library.saveProgress(bookId, k);
    });
  } catch (err) {
    root.replaceChildren(h('div', { className: 'empty-tip' }, [(err as Error).message]));
    return () => undefined;
  }

  // 点选纸面落点 → 新建批注
  canvas.addEventListener('click', (e) => {
    const hit = renderer.pickAnnotation(e.clientX, e.clientY);
    if (!hit) {
      toast('请点在书页区域内');
      return;
    }
    openAnnotationModal(null, async (text, color) => {
      await library.addAnnotation({
        bookId,
        leafIndex: hit.leafIndex,
        side: hit.side,
        x: Math.max(0, hit.u - 0.12),
        y: Math.max(0, hit.v - 0.05),
        width: 0.24,
        height: 0.1,
        color,
        text,
      });
      renderer.setAnnotations(library.annotationsFor(bookId));
      toast('批注已贴上纸面，翻页将随之弯曲');
    });
  });

  const listHost = h('div', { className: 'ann-list' });
  function rerenderList(): void {
    const anns = library.annotationsFor(bookId).sort((a, b) => a.leafIndex - b.leafIndex || a.createdAt - b.createdAt);
    clearNode(listHost);
    if (!anns.length) {
      listHost.append(h('div', { className: 'empty-tip', style: 'padding:40px 0' }, [
        '尚无批注。',
        h('br'),
        '在左侧纸面上点击落点即可贴上便签。',
      ]));
      return;
    }
    for (const a of anns) listHost.append(buildItem(a));
  }

  function buildItem(a: Annotation): HTMLElement {
    const ta = h('textarea', {}, [a.text]) as HTMLTextAreaElement;
    const colorPick = h('select', {}, COLORS.map((c) =>
      h('option', { value: c, selected: c === a.color }, [c]),
    )) as HTMLSelectElement;
    return h('div', { className: 'ann-item', style: `border-left-color:${a.color}` }, [
      h('div', { className: 'ann-head' }, [
        h('span', {}, [`第 ${a.leafIndex + 1} 叶 · ${a.side === 'recto' ? '正面' : '背面'}`]),
        h('span', {}, [`(${(a.x * 100).toFixed(0)}%, ${(a.y * 100).toFixed(0)}%)`]),
      ]),
      ta,
      h('div', { className: 'ann-btns' }, [
        h('span', { style: 'flex:1' }, [colorPick]),
        h('button', {
          onclick: async () => {
            await library.updateAnnotation(a.id, { text: ta.value, color: colorPick.value });
            renderer.setAnnotations(library.annotationsFor(bookId));
            toast('已保存');
          },
        }, ['保存']),
        h('button', {
          className: 'primary',
          onclick: () => {
            renderer.goto(a.leafIndex);
            toast('已定位到该叶');
          },
        }, ['定位']),
        h('button', {
          className: 'danger',
          onclick: async () => {
            await library.removeAnnotation(a.id);
            renderer.setAnnotations(library.annotationsFor(bookId));
            rerenderList();
          },
        }, ['删除']),
      ]),
    ]);
  }

  const bar = h('div', { className: 'reader-bar' }, [
    h('button', { onclick: () => go('library') }, ['← 书库']),
    h('button', { onclick: () => go(`reader/${encodeURIComponent(bookId)}`) }, ['返回阅读']),
    h('div', { className: 'spacer' }),
    h('button', { onclick: () => renderer.prev() }, ['◀ 前翻']),
    h('button', { className: 'primary', onclick: () => renderer.next() }, ['后翻 ▶']),
  ]);

  const right = h('div', { style: 'display:flex;flex-direction:column;min-height:0;gap:12px' }, [
    h('div', { style: 'display:flex;align-items:center;gap:10px' }, [
      h('h3', { style: 'margin:0;font-family:var(--font-kai);font-weight:normal;letter-spacing:3px;color:#ffe2b8' }, ['批注册']),
      h('span', { className: 'hint' }, ['点击纸面落点新建']),
    ]),
    listHost,
  ]);

  const layout = h('div', { style: 'height:100%;display:flex;flex-direction:column;padding:18px 22px;gap:14px;overflow:hidden' }, [
    h('div', { style: 'flex:1;min-height:0;display:grid;grid-template-columns:1fr 360px;gap:18px' }, [stage, right]),
    bar,
  ]);
  root.replaceChildren(layout);
  rerenderList();

  const off = library.changed.on(() => {
    renderer.setAnnotations(library.annotationsFor(bookId));
    rerenderList();
  });
  onDispose(root, () => {
    off();
    renderer.dispose();
  });
  return () => undefined;
}

function openAnnotationModal(existing: Annotation | null, onSave: (text: string, color: string) => void): void {
  const ta = h('textarea', { rows: 5, placeholder: '写批注……（可记校勘、心得、释文）' }) as HTMLTextAreaElement;
  let color = existing?.color ?? COLORS[0];
  const swatches = h('div', { className: 'seg' }, COLORS.map((c) => {
    const btn = h('button', {
      className: c === color ? 'on' : '',
      style: `background:${c};color:#3a2a18;min-width:44px;border-color:transparent`,
      onclick: () => {
        color = c;
        for (const b of swatches.children) b.classList.remove('on');
        btn.classList.add('on');
      },
    }, ['色']);
    return btn;
  }));
  const body = h('div', {}, [
    h('div', { className: 'form-row' }, [h('label', {}, ['批注内容']), ta]),
    h('div', { className: 'form-row' }, [h('label', {}, ['便签颜色']), swatches]),
  ]);
  const modal = openModal('新增批注', body);
  body.append(h('div', { className: 'modal-actions' }, [
    h('button', { onclick: () => modal.close() }, ['取消']),
    h('button', {
      className: 'primary',
      onclick: () => {
        if (!ta.value.trim()) return toast('批注内容不能为空');
        onSave(ta.value.trim(), color);
        modal.close();
      },
    }, ['贴上纸面']),
  ]));
  setTimeout(() => ta.focus(), 0);
}
