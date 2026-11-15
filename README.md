# 芸编 · 古籍阅藏系统

浏览器内的线装古籍阅读系统。TypeScript + WebGL2 自研渲染，无第三方图形/框架依赖，所有数据本地存储、可离线运行。

## 运行

```bash
npm install
npm run dev        # 开发
npm run build      # 类型检查 + 生产构建（输出 dist/）
npm run preview    # 预览构建产物
```

要求支持 WebGL2 的现代浏览器（Chrome/Edge/Firefox 近三年版本）。

## 功能与实现

| 需求 | 实现方式 |
| --- | --- |
| 书目增删改、扫描图导入、浏览器内导出导入 | IndexedDB 存原图 Blob 与元数据；导出为单 JSON（图像 dataURL 内嵌），导入时全量重映射 id 避免冲突 |
| 筒子页装订、左右翻 | 叶（leaf）抽象：每叶含 recto/verso 两面；双叠 + 单动叶模型，中缝装订 |
| 物理卷曲、拖到哪弯到哪、松手按速度成页/回弹 | 顶点着色器内**解析化圆柱卷曲**（弧长守恒两阶段模型），拖动每帧只更新 `uProgress` 一个 uniform，CPU 零顶点计算 |
| 快速连翻不穿模、不乱序 | `FlipController` 状态机：任何时刻只有一个动叶，连翻只推进 `target`，动画串行追赶；提交历史可验证叶号严格连续 |
| 宣纸透光、背面透字 | 片元着色器按法线折角计算透光系数，镜像采样背面纹理混入 |
| 泛黄/虫蛀/霉斑可调、不改原图 | 全部程序化噪声（FBM、网格随机虫洞、低频霉斑），原图 Blob 字节永不修改 |
| 批注贴页、随纸弯曲 | 批注画在与叶面同 UV 的覆盖纹理上，作为同一网格的附加纹理通道，天然随卷曲变形 |
| 缩放平移、截图带书名页码 | 正交相机矩阵缩放平移；`readPixels` 离屏读回 + canvas 题签条导出 PNG |
| 台灯/自然光 | 两套光照模型：暖色点光距离衰减 vs 冷调平行方向光，灯位可点选 |

## 目录结构

```
src/
├─ types.ts                 数据模型与默认设置
├─ services/
│  ├─ idb.ts                IndexedDB 封装（books/images/annotations）
│  ├─ store.ts              书库与设置的内存仓库 + 变更通知
│  └─ libraryIO.ts          导出/导入（dataURL 编解码、id 重映射）
├─ webgl/
│  ├─ shaders.ts            全部 GLSL：卷曲变形、老化、透光、光照
│  ├─ gl.ts                 程序编译/网格/UV 矩阵/环衬纹理
│  ├─ textures.ts           纹理 LRU 缓存 + 批注覆盖层
│  ├─ flip.ts               翻页状态机（并发安全的核心）
│  ├─ leafMath.ts           与 shader 同步的 TS 卷曲数学（拾取反算）
│  └─ BookRenderer.ts       场景编排、相机、指针交互、截图
├─ ui/
│  ├─ router.ts             hash 路由
│  ├─ components/common.ts  Toast/模态框/缩略图
│  └─ pages/                library/reader/editor/annotations/settings
└─ main.ts
scripts/gen-fixtures.mjs    生成 12 张模拟扫描页（无第三方依赖的 PNG 编码器）
```

## 关键设计决策

**为什么卷曲放在顶点着色器而不是 CPU 网格？**
跟手拖动要求每帧更新曲面。解析公式把"弧长 d → 圆柱位置"直接写进 shader，CPU 每帧只写一个浮点 uniform，56×36 的网格完全在 GPU 变形，主线程零分配、零顶点缓冲写入。

**为什么连翻不会穿模？**
场景里永远只有三种几何：左叠顶页、右叠顶页、至多一个动叶。状态机保证动叶提交（k 移动）后才允许创建下一个动叶；连翻按钮不直接操作几何，只把目标叶号推远，动画队列串行消化。物理上不存在两叶同时在空中的可能。

**俯仰视角**
纯正交俯视时 Z 轴卷曲不可见，因此书本整体绕 X 轴倾斜固定角度（`tilt`），让纸卷的高度投影到屏幕，同时保持正交相机的缩放平移简单可控。

## 测试夹具

```bash
node scripts/gen-fixtures.mjs   # 生成 test-fixtures/scan-01..12.png
```

在书页编辑页多选导入，或用浏览器 fetch 后经 `library.appendImages` 灌入。
