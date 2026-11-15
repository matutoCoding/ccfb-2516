// 书页编辑页：扫描图导入、叶序调整、旋转、删除、封面设置、单书导出
import type { Book, PageImage } from '../../types';
import { library } from '../../services/store';
import { db } from '../../services/idb';
import { exportBooks } from '../../services/libraryIO';
import { clearNode, downloadBlob, h } from '../../utils/dom';
import { confirmDialog, emptyText, thumbUrl, toast } from '../components/common';
import { go, onDispose } from '../router';

const ROTATIONS: Array<PageImage['rotation']> = [0, 90, 180, 270];

export function renderEditor(root: HTMLElement, bookId: string): void {
  const book = library.getBook(bookId);
  if (!book) {
    emptyText(root, '书目不存在');
    return;
  }

  const strip = h('div', { className: 'leaf-strip' });

  async function rerender(): Promise<void> {
    const fresh = library.getBook(bookId)!;
    clearNode(strip);
    if (!fresh.leafImageIds.length) {
      emptyText(strip, '尚无扫描页 —— 使用右侧面板导入一组图片（每张图即一个筒子叶）');
      return;
    }
    for (let i = 0; i < fresh.leafImageIds.length; i++) {
      strip.append(await buildLeafCard(fresh, i));
    }
  }

  const fileInput = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    style: 'display:none',
    onchange: async () => {
      const files = [...(fileInput as HTMLInputElement).files ?? []];
      (fileInput as HTMLInputElement).value = '';
      if (!files.length) return;
      // 按文件名自然排序，保证扫描序列正确
      files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
      const blobs = files.map((f) => f.slice(0, f.size, f.type || 'image/png'));
      await library.appendImages(bookId, blobs);
      toast(`已导入 ${blobs.length} 叶`);
      rerender();
    },
  }) as HTMLInputElement;

  const side = h('div', { className: 'side-panel' }, [
    h('h3', { style: 'margin:0;font-family:var(--font-kai);font-weight:normal;letter-spacing:3px;color:#ffe2b8' }, ['书页管理']),
    h('button', {
      className: 'primary',
      onclick: () => fileInput.click(),
    }, ['导入扫描图（可多选）']),
    h('p', { className: 'hint' }, [
      '· 每个图片文件视为一个筒子叶（含正反两面）',
      h('br'),
      '· 原图仅存浏览器本地，旋转/老化均不修改原文件',
      h('br'),
      '· 支持 JPG / PNG / WebP 等浏览器可解码格式',
    ]),
    h('button', {
      onclick: async () => {
        const blob = await exportBooks([bookId]);
        downloadBlob(blob, `${book.title}-芸编导出.json`);
        toast('单书已导出（含全部图像与批注）');
      },
    }, ['导出本书']),
    h('button', { onclick: () => go(`reader/${encodeURIComponent(bookId)}`) }, ['前往阅读']),
    h('button', { onclick: () => go(`annotations/${encodeURIComponent(bookId)}`) }, ['管理批注']),
  ]);

  const head = h('div', { className: 'page-head' }, [
    h('button', { onclick: () => go('library') }, ['← 书库']),
    h('h2', {}, [`书页编辑 · ${book.title}`]),
  ]);

  const wrap = h('div', { className: 'editor-wrap', style: 'width:100%' }, [strip, side]);
  const host = h('div', { style: 'padding:24px 30px;height:100%;overflow:auto;display:flex;flex-direction:column' }, [head, wrap]);
  root.replaceChildren(host, fileInput);
  void rerender();

  const off = library.changed.on(() => void rerender());
  onDispose(root, off);
}

async function buildLeafCard(book: Book, index: number): Promise<HTMLElement> {
  const imageId = book.leafImageIds[index];
  const img = await db.getImage(imageId);
  const url = await thumbUrl(async () => (await db.getImage(imageId))?.blob, `leaf-${imageId}`);

  const thumb = h('div', { className: 'thumb' }, [
    url ? h('img', {
      src: url,
      style: `transform: rotate(${img?.rotation ?? 0}deg)`,
      alt: `第 ${index + 1} 叶`,
    }) : h('span', { className: 'placeholder' }, ['…']),
  ]);

  const isCover = book.coverImageId === imageId;
  const card = h('div', { className: 'leaf-card', dataset: { index: String(index) } }, [
    h('div', { className: 'idx' }, [`叶 ${index + 1}${isCover ? ' · 封面' : ''}`]),
    thumb,
    h('div', { className: 'leaf-btns' }, [
      h('button', {
        onclick: () => library.moveLeaf(book.id, index, index - 1),
        disabled: index === 0,
      }, ['前移']),
      h('button', {
        onclick: () => library.moveLeaf(book.id, index, index + 1),
        disabled: index === book.leafImageIds.length - 1,
      }, ['后移']),
      h('button', {
        onclick: async () => {
          const next = ROTATIONS[(ROTATIONS.indexOf(img?.rotation ?? 0) + 1) % 4];
          await library.setRotation(book.id, index, next);
        },
      }, ['旋转']),
      h('button', {
        onclick: () => library.setCover(book.id, index),
        className: isCover ? 'primary' : '',
      }, [isCover ? '✓ 封面' : '设封面']),
      h('button', {
        className: 'danger',
        onclick: async () => {
          if (await confirmDialog(`删除第 ${index + 1} 叶？该叶上的批注会一并移除。`)) {
            await library.removeLeaf(book.id, index);
            toast('已删除');
          }
        },
      }, ['删除']),
    ]),
  ]);
  return card;
}
