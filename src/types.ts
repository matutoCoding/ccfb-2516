// 全局数据模型 —— 所有持久化数据的唯一事实来源

export interface PageImage {
  id: string;
  /** 原始扫描图，Blob（image/*），永不被修改（老化效果只发生在 shader 中） */
  blob: Blob;
  /** 展示方向：0/90/180/270 度，仅元数据，不改动 Blob */
  rotation: 0 | 90 | 180 | 270;
  /** 导入时间 */
  createdAt: number;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  description: string;
  /** 叶（筒子页）序列，每个叶含正反两面，指向 PageImage id；奇数页时末叶可为单面 */
  leafImageIds: string[];
  coverImageId: string | null;
  /** 阅读进度：当前展开的叶对索引（0 = 封面翻开前） */
  progress: number;
  createdAt: number;
  updatedAt: number;
  /** 该书独立的老化参数（缺省回落到全局设置） */
  aging?: Partial<AgingParams>;
}

/** 批注锚定在某一物理面上：leafIndex 为叶序号，side 为该叶的 recto/verso */
export interface Annotation {
  id: string;
  bookId: string;
  leafIndex: number;
  side: 'recto' | 'verso';
  /** 归一化坐标（0..1，相对该面纹理，左上原点） */
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string;
  createdAt: number;
}

export interface AgingParams {
  /** 泛黄 0..1 */
  yellowing: number;
  /** 虫蛀 0..1（程序化孔洞） */
  wormhole: number;
  /** 霉斑 0..1 */
  mildew: number;
  /** 纸张老化整体强度 0..1 */
  overall: number;
}

export type LightingMode = 'natural' | 'lamp';

export interface ReaderSettings {
  aging: AgingParams;
  /** 宣纸透光强度 0..1（背面字迹透显） */
  translucency: number;
  lighting: LightingMode;
  /** 台灯色温位置（归一化屏幕坐标） */
  lampX: number;
  lampY: number;
  /** 翻页动画时长 ms */
  flipDuration: number;
  /** 背景暗角强度 */
  vignette: number;
}

export const DEFAULT_AGING: AgingParams = {
  yellowing: 0.35,
  wormhole: 0.12,
  mildew: 0.1,
  overall: 0.5,
};

export const DEFAULT_SETTINGS: ReaderSettings = {
  aging: { ...DEFAULT_AGING },
  translucency: 0.45,
  lighting: 'natural',
  lampX: 0.72,
  lampY: 0.28,
  flipDuration: 650,
  vignette: 0.55,
};

/** 导出文件格式 */
export interface ExportPayload {
  format: 'yunbian-library';
  version: 1;
  exportedAt: number;
  books: Array<Omit<Book, 'createdAt' | 'updatedAt'> & {
    createdAt: number;
    updatedAt: number;
  }>;
  images: Array<{ id: string; dataUrl: string; rotation: 0 | 90 | 180 | 270; createdAt: number }>;
  annotations: Annotation[];
}
