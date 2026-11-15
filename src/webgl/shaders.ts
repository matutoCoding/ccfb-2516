// 全部 GLSL ES 3.00 着色器。
// 设计要点：
// 1) 书页卷曲完全在顶点着色器里以解析公式完成，CPU 每帧只更新 uProgress 一个 uniform；
// 2) 老化（泛黄/虫蛀/霉斑）全部程序化，原始扫描纹理永不修改；
// 3) 背面通过采样正面纹理 + 法线透光系数实现宣纸透字。

export const LEAF_VERT = /* glsl */ `#version 300 es
precision highp float;

in vec2 aUV;       // 叶面局部坐标：x 沿书脊→书口 0..1，y 沿天头→地脚 0..1
uniform float uProgress;   // 翻页进度 0..1
uniform float uDir;        // +1 向右起翻（右→左），-1 向左起翻（左→右）
uniform float uPageW;      // 半页宽（世界单位）
uniform float uPageH;      // 页高
uniform float uGap;        // 中缝间隙
uniform float uR0;         // 最大卷曲半径
uniform float uLift;       // 静止叶的微 z 抬升，防 z-fighting
uniform float uTilt;       // 书本俯仰角（弧度），绕 X 轴倾斜以显卷曲
uniform mat3  uCamera;     // 缩放平移（正交，z 不动）

out vec2 vUV;
out vec3 vNormal;
out vec3 vWorldPos;

const float EPS_R = 0.004; // 翻页终态残余半径，避免除零与穿模

// 解析滚筒卷曲：返回以书脊为原点的局部坐标（X 向外为正，Z 向上）
vec3 deformLeaf(float u, float v) {
  float W = uPageW;
  float d = u * W;                       // 距装订边的弧长
  float p = clamp(uProgress, 0.0, 1.0);
  float R, phi, b, lf;
  if (p <= 0.5) {
    // 阶段 A：圆柱以近似定径滚动，绕角 0→π，右平展段被卷起
    float q = p * 2.0;
    phi = 3.14159265 * q;
    R = uR0 * (1.0 - 0.25 * q);          // 仅轻微收径，保持中段弧面饱满
    b = W - R * phi;                     // 右侧平展段
    lf = 0.0;
  } else {
    // 阶段 B：绕角保持 π，半径快速收缩，圆柱滚向书脊，左平展段生长
    float q = p * 2.0 - 1.0;
    phi = 3.14159265;
    float Rstart = uR0 * 0.75;
    R = mix(Rstart, EPS_R, q * q);
    float b0 = W - 3.14159265 * Rstart;
    b = b0 * (1.0 - q);                  // 右侧平展段收缩
    lf = W - b - 3.14159265 * R;         // 弧长守恒给出左平展段
  }
  float X, Z;
  if (d <= b) {
    // 近侧平展段
    X = uGap + d;
    Z = 0.0;
  } else if (d <= b + R * phi) {
    // 圆柱弧面
    float theta = (d - b) / max(R, 1e-4);
    float cx = uGap + b - R;
    X = cx + R * sin(theta);
    Z = R - R * cos(theta);
  } else {
    // 远侧平展段
    X = uGap + b - 2.0 * R - (d - b - R * phi);
    Z = 0.0;
  }
  float x = uDir * X;
  float y = (0.5 - v) * uPageH;
  return vec3(x, y, Z + uLift);
}

void main() {
  // aUV.y 向下为正（天头 0 → 地脚 1），而 GL 纹理坐标向上为正，这里翻一次
  vUV = vec2(aUV.x, 1.0 - aUV.y);
  vec3 pos = deformLeaf(aUV.x, aUV.y);
  // 有限差分求曲面法线（弧长守恒参数化，差分即弧长差分）
  float du = 1.0 / 64.0;
  float dv = 1.0 / 48.0;
  vec3 px1 = deformLeaf(clamp(aUV.x + du, 0.0, 1.0), aUV.y);
  vec3 px0 = deformLeaf(clamp(aUV.x - du, 0.0, 1.0), aUV.y);
  vec3 py1 = deformLeaf(aUV.x, clamp(aUV.y + dv, 0.0, 1.0));
  vec3 py0 = deformLeaf(aUV.x, clamp(aUV.y - dv, 0.0, 1.0));
  vec3 tx = px1 - px0;
  vec3 ty = py1 - py0;
  vNormal = normalize(cross(ty, tx));
  // 绕 X 轴俯仰：桌面 y 收缩、卷曲高度 z 向上投影到屏幕，形成可见的立体翻页
  float ct = cos(uTilt);
  float st = sin(uTilt);
  vec3 tilted = vec3(pos.x, pos.y * ct + pos.z * st, -pos.y * st + pos.z * ct);
  vec3 cam = uCamera * vec3(tilted.xy, 1.0);
  vWorldPos = vec3(cam.xy, tilted.z);
  // 正交投影：z 仅用于深度比较，压缩到近平面附近避免被远裁剪面剔除
  gl_Position = vec4(cam.xy, (tilted.z - 0.35) * 0.18, 1.0);
}
`;

export const LEAF_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUV;
in vec3 vNormal;
in vec3 vWorldPos;

uniform sampler2D uFrontTex;   //  recto（当前朝向面）
uniform sampler2D uBackTex;    //  verso（背面）
uniform sampler2D uFrontAnn;   //  recto 批注层
uniform sampler2D uBackAnn;    //  verso 批注层
uniform mat3 uFrontUv;
uniform mat3 uBackUv;
uniform float uHasAnnFront;
uniform float uHasAnnBack;
uniform vec4 uAging;           // x 泛黄 y 虫蛀 z 霉斑 w 总强度
uniform float uTranslucency;
uniform int   uLighting;       // 0 自然光 1 台灯
uniform vec2 uLampPos;
uniform float uVignette;
uniform float uStackDepth;     // 该叠叶数，用于书口厚度压暗
uniform vec2 uBookSize;        // 书的世界尺寸，用于暗角

out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * vnoise(p);
    p *= 2.03;
    amp *= 0.5;
  }
  return v;
}

// 虫蛀：多层网格内随机圆洞，返回 1=完好 0=蛀空
float wormMask(vec2 uv, float density) {
  float mask = 1.0;
  for (int oct = 0; oct < 3; oct++) {
    float scale = 9.0 + float(oct) * 7.0;
    vec2 g = uv * scale;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float rnd = hash21(cell + float(oct) * 17.13);
    float alive = step(1.0 - density * 0.55, rnd);
    float rad = mix(0.03, 0.11, hash21(cell + 3.7)) * (0.5 + density);
    float dist = length(f);
    float hole = smoothstep(rad, rad * 0.55, dist);
    mask *= mix(1.0, 1.0 - hole, alive);
  }
  return mask;
}

void main() {
  bool isFront = gl_FrontFacing;
  vec2 uvF = (uFrontUv * vec3(vUV, 1.0)).xy;
  vec2 uvB = (uBackUv * vec3(vUV, 1.0)).xy;
  vec3 paperF = texture(uFrontTex, uvF).rgb;
  vec3 paperB = texture(uBackTex, uvB).rgb;

  // ---- 宣纸透光：正面隐约透出背面的字（反之亦然），折角越大透光越强 ----
  vec3 N = normalize(vNormal);
  vec3 Nface = isFront ? N : -N;
  float through = uTranslucency * (0.25 + 0.75 * (1.0 - abs(Nface.z)));
  vec3 base;
  vec3 annColor = vec3(0.0);
  float annAlpha = 0.0;
  if (isFront) {
    // 本面纸色为主，按透光量混入背面（镜像采样，模拟纸背透影）
    vec3 backShow = texture(uBackTex, vec2(1.0 - uvB.x, uvB.y)).rgb;
    base = mix(paperF, backShow, clamp(through, 0.0, 0.55));
    if (uHasAnnFront > 0.5) {
      vec4 a = texture(uFrontAnn, vUV);
      annColor = a.rgb; annAlpha = a.a;
    }
  } else {
    vec3 frontShow = texture(uFrontTex, vec2(1.0 - uvF.x, uvF.y)).rgb;
    base = mix(paperB, frontShow, clamp(through, 0.0, 0.55));
    if (uHasAnnBack > 0.5) {
      vec4 a = texture(uBackAnn, vUV);
      annColor = a.rgb; annAlpha = a.a;
    }
  }

  float aging = uAging.w;
  // ---- 泛黄：整体向陈旧纸色偏移，叠加细颗粒与年代不均匀感 ----
  float grain = fbm(vUV * 26.0);
  float yellow = uAging.x * aging;
  vec3 agedTint = vec3(0.78, 0.65, 0.40);
  base = mix(base, agedTint * (0.82 + 0.3 * grain), yellow * 0.55);
  base *= 1.0 - yellow * 0.18 * (1.0 - grain);

  // ---- 霉斑：低频色斑，暗绿褐色 ----
  float mold = fbm(vUV * 6.0 + 11.7);
  float moldAmt = smoothstep(0.58, 0.78, mold) * uAging.z * aging;
  base = mix(base, base * vec3(0.42, 0.45, 0.30), moldAmt * 0.75);

  // ---- 虫蛀孔洞（平滑边缘） ----
  float worm = wormMask(vUV + hash21(vUV * 3.1) * 0.3, uAging.y * aging);
  if (worm < 0.25) discard;
  base *= mix(1.0, worm, 0.85);

  // ---- 批注贴在纸面上（先老化纸张再贴批注，保证字迹可读），并随纸色轻微旧化 ----
  if (annAlpha > 0.01) {
    annColor = mix(annColor, annColor * vec3(0.92, 0.86, 0.66), yellow * 0.4);
    base = mix(base, annColor, annAlpha * 0.92);
  }

  // ---- 光照 ----
  vec3 lit;
  if (uLighting == 1) {
    // 台灯：低环境光 + 暖色点光，距离衰减
    vec3 L3 = vec3(uLampPos - vWorldPos.xy, 0.55 * uBookSize.y);
    float dist = length(L3);
    vec3 L = L3 / max(dist, 1e-3);
    float diff = max(dot(Nface, L), 0.0);
    float atten = 1.0 / (1.0 + 0.12 * dist * dist + 0.5 * dist);
    vec3 warm = vec3(1.0, 0.86, 0.62);
    lit = base * (vec3(0.30, 0.28, 0.26) + warm * diff * atten * 1.35);
  } else {
    // 自然光：偏冷方向光 + 较高环境光
    vec3 L = normalize(vec3(-0.45, 0.62, 0.75));
    float diff = max(dot(Nface, L), 0.0);
    lit = base * (vec3(0.72, 0.74, 0.78) + vec3(0.34, 0.33, 0.30) * diff);
  }

  // ---- 书口厚度：靠近书口缘（u→1）随叠层厚度压暗，并叠一层细密层纹 ----
  float edgeAmt = smoothstep(0.82, 1.0, vUV.x) * clamp(uStackDepth / 14.0, 0.0, 1.0);
  float layerLines = 0.5 + 0.5 * sin(vUV.y * 460.0);
  lit *= 1.0 - edgeAmt * (0.22 + 0.10 * layerLines);

  // ---- 暗角 ----
  vec2 nc = vWorldPos.xy / uBookSize;
  float vig = 1.0 - smoothstep(0.55, 1.05, length(nc)) * uVignette;
  lit *= vig;

  outColor = vec4(clamp(lit, 0.0, 1.0), 1.0);
}
`;

// 桌面 / 背景全屏着色器
export const BG_VERT = `#version 300 es
precision highp float;
in vec2 aPos;
out vec2 vPos;
void main() {
  vPos = aPos;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export const BG_FRAG = `#version 300 es
precision highp float;
in vec2 vPos;
uniform int uLighting;
uniform vec2 uLampNdc;
out vec4 outColor;
void main() {
  vec3 desk;
  if (uLighting == 1) {
    float d = length(vPos - uLampNdc);
    float glow = 1.0 / (1.0 + 2.2 * d * d);
    desk = mix(vec3(0.055, 0.045, 0.038), vec3(0.32, 0.25, 0.17), glow);
  } else {
    float d = length(vPos * vec2(0.8, 1.0));
    desk = mix(vec3(0.20, 0.18, 0.16), vec3(0.10, 0.09, 0.085), smoothstep(0.2, 1.3, d));
  }
  outColor = vec4(desk, 1.0);
}`;
