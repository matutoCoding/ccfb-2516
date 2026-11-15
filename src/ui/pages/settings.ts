// 设置页：纸张老化、透光、光照模式、翻页参数、数据管理（全部实时生效，不改原图）
import type { ReaderSettings } from '../../types';
import { settingsStore } from '../../services/store';
import { db } from '../../services/idb';
import { exportBooks, importLibrary } from '../../services/libraryIO';
import { downloadBlob, h } from '../../utils/dom';
import { confirmDialog, toast } from '../components/common';
import { onDispose } from '../router';

export function renderSettings(root: HTMLElement): void {
  const s = settingsStore.get();

  // ---- 纸张老化 ----
  const agingCard = h('div', { className: 'setting-card' }, [
    h('h3', {}, ['纸张老化（着色器程序化处理，原始扫描图永不修改）']),
    slider('老化总强度', s.aging.overall, (v) => settingsStore.updateAging({ overall: v })),
    slider('泛黄程度', s.aging.yellowing, (v) => settingsStore.updateAging({ yellowing: v })),
    slider('虫蛀程度', s.aging.wormhole, (v) => settingsStore.updateAging({ wormhole: v })),
    slider('霉斑程度', s.aging.mildew, (v) => settingsStore.updateAging({ mildew: v })),
    h('p', { className: 'hint' }, ['虫蛀为程序化孔洞、霉斑为低频色斑、泛黄为纸色偏移与颗粒，三者可叠加。']),
  ]);

  // ---- 纸质 ----
  const paperCard = h('div', { className: 'setting-card' }, [
    h('h3', {}, ['宣纸质感']),
    slider('透光强度（背面透字）', s.translucency, (v) => settingsStore.update({ translucency: v }), 0, 1, 0.01),
    slider('背景暗角', s.vignette, (v) => settingsStore.update({ vignette: v })),
  ]);

  // ---- 光照 ----
  const lampPad = h('div', {
    style: 'position:relative;height:150px;border:1px solid #3d2f1f;border-radius:8px;background:radial-gradient(circle at 72% 28%, #4a3826, #15100a 70%);cursor:crosshair;',
  });
  const dot = h('div', { className: 'lamp-dot', style: 'position:absolute;transform:translate(-50%,-50%)' });
  lampPad.append(dot);
  function placeDot() {
    const cur = settingsStore.get();
    dot.style.left = `${cur.lampX * 100}%`;
    dot.style.top = `${cur.lampY * 100}%`;
  }
  placeDot();
  lampPad.addEventListener('click', (e) => {
    const rect = lampPad.getBoundingClientRect();
    settingsStore.update({
      lampX: (e.clientX - rect.left) / rect.width,
      lampY: (e.clientY - rect.top) / rect.height,
    });
    placeDot();
  });

  const naturalBtn = h('button', {
    className: s.lighting === 'natural' ? 'on' : '',
    onclick: () => settingsStore.update({ lighting: 'natural' }),
  }, ['自然光']);
  const lampBtn = h('button', {
    className: s.lighting === 'lamp' ? 'on' : '',
    onclick: () => settingsStore.update({ lighting: 'lamp' }),
  }, ['台灯']);

  const lightCard = h('div', { className: 'setting-card' }, [
    h('h3', {}, ['光照环境']),
    h('div', { className: 'seg', style: 'margin-bottom:14px' }, [naturalBtn, lampBtn]),
    h('label', { style: 'display:block;margin-bottom:6px' }, ['台灯位置（点击色块移动光源，仅台灯模式生效）']),
    lampPad,
  ]);

  // ---- 翻页 ----
  const flipCard = h('div', { className: 'setting-card' }, [
    h('h3', {}, ['翻页手感']),
    slider('动画时长（毫秒）', s.flipDuration, (v) => settingsStore.update({ flipDuration: Math.round(v) }), 250, 1400, 10),
    h('p', { className: 'hint' }, [
      '拖动时书页实时跟手，CPU 不做顶点计算；松手后依据拖动速度决定成页或回弹。',
      h('br'),
      '快速连翻时翻页请求进入串行队列，一次只有一叶在动，从机制上杜绝穿模与页序错乱。',
    ]),
  ]);

  // ---- 数据管理 ----
  const importInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
    onchange: async () => {
      const file = (importInput as HTMLInputElement).files?.[0];
      (importInput as HTMLInputElement).value = '';
      if (!file) return;
      try {
        const n = await importLibrary(file);
        toast(`成功导入 ${n} 部书`);
      } catch (err) {
        toast(`导入失败：${(err as Error).message}`, 3600);
      }
    },
  }) as HTMLInputElement;

  const dataCard = h('div', { className: 'setting-card' }, [
    h('h3', {}, ['数据管理']),
    h('p', { className: 'hint' }, [
      '全部数据（书目元数据、扫描原图、批注、阅读进度）保存在浏览器 IndexedDB 与 localStorage，离线可用。',
      h('br'),
      '导出文件为单个 JSON，图像以 dataURL 内嵌，可在另一台浏览器导入。',
    ]),
    h('div', { className: 'seg', style: 'flex-wrap:wrap' }, [
      h('button', {
        onclick: async () => {
          const blob = await exportBooks();
          downloadBlob(blob, `芸编书库-${new Date().toISOString().slice(0, 10)}.json`);
          toast('书库已导出');
        },
      }, ['导出整个书库']),
      h('button', { onclick: () => importInput.click() }, ['导入书库 JSON']),
      h('button', {
        className: 'danger',
        onclick: async () => {
          if (!(await confirmDialog('清空本机全部书目、扫描图与批注？建议先导出备份。'))) return;
          await db.clearAll();
          location.reload();
        },
      }, ['清空全部数据']),
      h('button', {
        onclick: () => {
          settingsStore.reset();
          toast('阅读设置已恢复默认');
          renderSettings(root);
        },
      }, ['恢复默认设置']),
    ]),
    importInput,
  ]);

  const wrap = h('div', { className: 'settings-wrap' }, [agingCard, paperCard, lightCard, flipCard, dataCard]);
  const host = h('div', {}, [
    h('div', { className: 'page-head' }, [h('h2', {}, ['设置'])]),
    wrap,
  ]);
  root.replaceChildren(host);

  // 光照按钮高亮随设置变化
  const off = settingsStore.changed.on((cur: ReaderSettings) => {
    naturalBtn.classList.toggle('on', cur.lighting === 'natural');
    lampBtn.classList.toggle('on', cur.lighting === 'lamp');
  });
  onDispose(root, off);
}

function slider(label: string, value: number, onChange: (v: number) => void, min = 0, max = 1, step = 0.01): HTMLElement {
  const out = h('output', {}, [String(value)]);
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = String(v);
    onChange(v);
  });
  return h('div', { className: 'slider-row' }, [h('label', {}, [label]), input, out]);
}
