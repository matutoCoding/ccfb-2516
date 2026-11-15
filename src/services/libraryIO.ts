// 书库导出 / 导入：扫描图转 dataURL 打包为单个 JSON；导入重新生成 id 避免冲突
import type { Annotation, Book, ExportPayload, PageImage } from '../types';
import { uid } from '../utils/dom';
import { db } from './idb';
import { library } from './store';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',');
  const mime = /:(.*?);/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

/** 导出整本 / 整个书库 */
export async function exportBooks(bookIds?: string[]): Promise<Blob> {
  const all = library.getBooks();
  const books = bookIds ? all.filter((b) => bookIds.includes(b.id)) : all;
  const imageIds = new Set<string>();
  for (const b of books) {
    b.leafImageIds.forEach((id) => imageIds.add(id));
    if (b.coverImageId) imageIds.add(b.coverImageId);
  }
  const images: ExportPayload['images'] = [];
  for (const id of imageIds) {
    const img = await db.getImage(id);
    if (!img) continue;
    images.push({ id, dataUrl: await blobToDataUrl(img.blob), rotation: img.rotation, createdAt: img.createdAt });
  }
  const annotations = library.annotationsFor('').length >= 0
    ? (await db.allAnnotations()).filter((a) => books.some((b) => b.id === a.bookId))
    : [];
  const payload: ExportPayload = {
    format: 'yunbian-library',
    version: 1,
    exportedAt: Date.now(),
    books: books.map((b) => ({ ...b })),
    images,
    annotations,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

/** 导入；返回导入书目数。merge=true 时与现有数据共存（id 全部重映射） */
export async function importLibrary(file: File): Promise<number> {
  const payload = JSON.parse(await file.text()) as ExportPayload;
  if (payload.format !== 'yunbian-library' || payload.version !== 1) {
    throw new Error('文件格式不受支持：需要芸编书库导出的 JSON');
  }
  const imageIdMap = new Map<string, string>();
  const newImages: PageImage[] = [];
  for (const img of payload.images) {
    const newId = uid();
    imageIdMap.set(img.id, newId);
    newImages.push({ id: newId, blob: dataUrlToBlob(img.dataUrl), rotation: img.rotation, createdAt: img.createdAt });
  }
  const bookIdMap = new Map<string, string>();
  const newBooks: Book[] = payload.books.map((b) => {
    const newId = uid();
    bookIdMap.set(b.id, newId);
    return {
      ...b,
      id: newId,
      leafImageIds: b.leafImageIds.map((old) => imageIdMap.get(old)!).filter(Boolean),
      coverImageId: b.coverImageId ? (imageIdMap.get(b.coverImageId) ?? null) : null,
      progress: 0,
    };
  });
  const newAnnotations: Annotation[] = payload.annotations
    .filter((a) => bookIdMap.has(a.bookId))
    .map((a) => ({
      ...a,
      id: uid(),
      bookId: bookIdMap.get(a.bookId)!,
    }));
  await db.bulkImport(newBooks, newImages, newAnnotations);
  await library.load();
  const allBooks = await db.allBooks();
  const allAnns = await db.allAnnotations();
  library.reloadAfterImport(allBooks, allAnns);
  return newBooks.length;
}
