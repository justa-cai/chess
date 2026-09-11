# 产品需求文档 (PRD): Web 象棋对弈系统 (Pikafish-WASM)

## 1. 项目概述

* **项目名称**：Chinese-Chess-AI（纯前端高性能 Web 象棋）
* **定位**：零后端开销、纯前端运行的现代化中国象棋对弈应用。
* **核心亮点**：
  * **零服务器计算**：Pikafish 神经网络评估引擎（NNUE）通过 WebAssembly（WASM）纯本地运行。
  * **主线程零卡顿**：引擎常驻 Web Worker，多线程并行计算，UI 保持 60fps 响应。
  * **权威规则与评估**：基于 UCI 协议流式输出搜索分与多核 NPS，在本地进行深度搜索与规则校验。

---

## 2. 技术架构与分层

应用设计遵循 **“视图 UI - 业务裁判 - 算力引擎” 三层解耦架构**：

```text
+---------------------------------------------------------+
|                    Web UI (视图层)                       |
|  xiangqiboard.js (棋盘渲染/动画) + Modern Clean CSS       |
+----------------------------+----------------------------+
                             | (事件: 尝试落子 / UCI)
                             v
+---------------------------------------------------------+
|             Web Worker 与 UCI 协议通信桥接              |
|       (js/worker/pikafish-engine.js + pre-js 桥接)       |
+----------------------------+----------------------------+
                             | (WASM / pthread / SharedArrayBuffer)
                             v
+---------------------------------------------------------+
|            Pikafish WASM 引擎 (C++17 算力核心)          |
|    - 51MB NNUE 神经网络评估网络 (/pikafish.nnue)        |
|    - 多线程并行搜索 (自动使用约 90% CPU 核心)           |
|    - UCI 标准协议 (go movetime 5000, info, bestmove)    |
+---------------------------------------------------------+
```

---

## 3. 核心功能需求 (Functional Requirements)

| 模块 | 功能项 | 详细描述 | 优先级 |
| --- | --- | --- | --- |
| **棋盘交互** | 棋子拖拽与点击 | 支持鼠标拖拽落子与“点击起子-点击落子”双模式；合法走法位置高亮显示。 | **P0** |
| **AI 对弈** | 5 秒定时思考 | 玩家落子后，向 Pikafish Worker 发送 `go movetime 5000`。引擎在 **5秒内** 返回 `bestmove`。 | **P0** |
| **规则判定** | 胜负与合法性 | 由 Pikafish `pikafish_validate_move` 与 `xiangqi.js` 判定走法合规性，在出现困毙、胜负或长将时弹出结果提示。 | **P0** |
| **对局控制** | 悔棋与重开 | 支持无限次“悔棋（撤回两步：玩家+AI）”，支持一键重新开局。 | **P0** |
| **UI 与 侧边栏** | 界面布局与 AI 日志 | 完全参考 `ui_example` 样式，包含计分徽章、多级菜单遮罩与侧边 AI 搜索评分日志面板。详见 [UI 界面规范文档](ui.md)。 | **P0** |

> **详细 UI 界面设计**：除中国象棋棋盘渲染外，本项目的全套 UI 结构、视觉样式、动画及侧边 AI 评估面板规范均完全参考 `ui_example` 实现，详见 [specs/ui.md](ui.md)。

---

## 4. 防“屎山” CSS 模块化体系

为防止样式越写越乱，项目采用 **Design Tokens（CSS 原生变量）+ 局部作用域命名** 方案，禁止硬编码（Magic Numbers）。

### 4.1 CSS 变量系统（`styles/tokens.css`）

所有颜色、尺寸、间距、过渡动画统一集中在根变量中管控：

```css
:root {
  /* 1. 颜色 Token */
  --color-bg-primary: #f4f1ea;
  --color-bg-card: #ffffff;
  --color-text-main: #2c3e50;
  --color-text-muted: #7f8c8d;
  --color-brand: #8c2d19;        /* 经典红木/印泥色 */
  --color-accent: #27ae60;       /* 高亮提示绿 */
  --color-board-border: #8d5b28;

  /* 2. 布局 Token */
  --board-max-width: 560px;
  --board-aspect-ratio: 9 / 10;
  --radius-card: 12px;
  --shadow-elevation: 0 10px 30px rgba(0, 0, 0, 0.08);

  /* 3. 动画 Token */
  --transition-fast: 0.15s ease;
  --transition-normal: 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
```

### 4.2 结构化 Style 目录组织

禁止将所有样式写在单个 `style.css` 中，结构按功能拆分：

```text
styles/
├── tokens.css        # 变量定义 (颜色、尺寸、动画)
├── base.css          # 重置样式 (Reset & Typography)
├── components/
│   ├── layout.css    # 整体容器 Grid/Flex 布局
│   ├── board.css     # 针对 xiangqiboard.js 外壳的修饰与高亮覆盖
│   ├── controls.css  # 按钮组、仪表盘、时间指示器
│   └── modal.css     # FEN 弹窗与对局结束提示
└── main.css          # 统一 @import 入口
```

### 4.3 响应式容器无溢出方案

采用 CSS `aspect-ratio` 与 `clamp()` 确保棋盘在手机和电脑上均能自动对齐且**绝对不挤爆屏幕**：

```css
/* components/layout.css */
.app-container {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.5rem;
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem;
}

/* 桌面端自动切换为左右双栏布局 */
@media (min-width: 768px) {
  .app-container {
    grid-template-columns: minmax(320px, var(--board-max-width)) 320px;
    align-items: start;
    justify-content: center;
  }
}

.board-wrapper {
  width: 100%;
  max-width: var(--board-max-width);
  aspect-ratio: var(--board-aspect-ratio);
  margin: 0 auto;
  box-shadow: var(--shadow-elevation);
  border-radius: 8px;
  overflow: hidden;
}
```

---
## 5. Web Worker 通信协议（已实现）

> 本节原先描述的是早期 ElephantEye / UCCI 方案，后来引擎整体迁移到了
> Pikafish（UCI），协议也随之重写。下面是**当前实际实现**的协议。

主线程与引擎 Worker 之间统一走 `js/engines/bridge.js`，协议要点：

**主线程 → Worker**

| type | 载荷 | 说明 |
|---|---|---|
| `INIT_ENGINE` | — | 启动引擎握手，Worker 回 `READY` |
| `SEARCH_LEVEL` | `seq, fen, startFen, moves[], level` | 按档位出着法 |
| `POSITION_STATUS` | `seq, fen` | 查该局面下合法着法数（终局判定） |
| `STOP_SEARCH` | — | 尽力而为；产物没有 asyncify，`go` 同步阻塞，实际无法中断 |
| `UCI_CMD` | `cmd` | 通用 UCI 透传，用于调试 |

**Worker → 主线程**

| type | 载荷 |
|---|---|
| `READY` | `engine` |
| `LOAD_STAGE` | `engine, stage`（`weights` / `cached` / `engine` / `handshake` / `ready`） |
| `LOAD_PROGRESS` | `engine, loaded, total`（权重下载进度，真实字节数） |
| `BEST_MOVE` | `seq, move, legalMoves, info` |
| `POSITION_STATUS_RESULT` | `seq, count` |
| `ERROR` | `message`（可带 `seq`） |

**两条关键约束**

1. **消息类型必须与 `pikafish-engine.js` 内建处理器错开**。那份 Emscripten 产物自带一个
   `handleIncomingMessage`，只认 `INIT` / `SEARCH` / `VALIDATE` / `STATUS` / `STOP`
   （无 else 分支，未知类型静默忽略）。包装层因此一律使用 `INIT_ENGINE` /
   `SEARCH_LEVEL` / `POSITION_STATUS` 等**不同的名字**，避免同一件事被处理两遍。
2. **`seq` 配对是必需的**。内建处理器在收到 `bestmove` 时会抢先往主线程发一条**不带 seq**
   的 `BEST_MOVE`；bridge 只认带 `seq` 的回包，据此把它过滤掉 ——
   否则难度采样会被完全绕过，档位形同虚设。

**难度分级不在这一层**。引擎本身没有 `Skill Level` / `UCI_Elo` 选项，档位参数
（搜索深度、MultiPV、采样温度、失误率）统一定义在 `js/difficulty.js`。

---

## 6. 开源与合规检查

* **开源许可证**：**GNU GPL v3.0**。根目录 `LICENSE` 为 GPLv3 全文。

  > 注：本节原先写的是 LGPL v2.1 —— 那是早期选用 ElephantEye（LGPL）时的方案。
  > 引擎换成 Pikafish（GPL-3.0）并把它的 WASM 产物随前端一起分发之后，
  > 整个前端产物都被 GPL-3.0 覆盖，因此实际许可是 GPLv3。

* **合规交付件**：
  1. 根目录 [`LICENSE`](../LICENSE)：GPLv3 全文。
  2. 根目录 [`NOTICE.md`](../NOTICE.md)：逐项列出 Pikafish、Wukong、xiangqi.js、
     xiangqiboardjs 的作者、许可、来源、校验值与修改说明。
  3. `README.md` / `README_CN.md`：写明双引擎架构与第三方组件表。

* **组件许可一览**：
  * 核心 AI：**Pikafish**（GPL-3.0）—— Emscripten 编译为 WASM，产物未作修改
  * 低档位引擎：**Wukong** by Maksym Korzh（MIT）
  * 规则库：`xiangqi.js` by Jeff Hlywa & lengyanyu258（BSD-2-Clause）
  * 棋盘渲染：`xiangqiboardjs` by Chris Oakman & lengyanyu258（MIT）

* **许可兼容性**：MIT 与 BSD-2-Clause 均可并入 GPL-3.0 项目。
  本项目**未**使用 GPL-2.0-only 的作品（如 `xqbase/xqwlight`）——
  这正是低档位引擎最终选择 WUKONG 而不是 XQWLight 的原因。
