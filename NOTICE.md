# 第三方组件与许可声明 / Third-Party Notices

本项目的**整体许可为 GNU General Public License v3.0**（见根目录 [`LICENSE`](LICENSE)）。
之所以是 GPL-3.0 而不是更宽松的许可，是因为核心算力引擎 Pikafish 采用 GPL-3.0，
而它被编译成 WebAssembly 后随本项目一起分发 —— GPL-3.0 的传染性会覆盖整个分发产物。

下面逐项列出本项目包含或改编的第三方作品。**如果你要基于本项目做二次分发，
必须一并保留这些声明与对应许可文本。**

---

## 1. Pikafish（皮卡鱼）— GPL-3.0

| 项 | 内容 |
|---|---|
| 作品 | Pikafish —— 中国象棋 UCI 引擎 |
| 上游 | https://github.com/official-pikafish/Pikafish |
| 作者 | 皮卡鱼开发组（Pikafish developers） |
| 许可 | **GNU GPL v3.0** |
| 本项目中的位置 | `js/worker/pikafish-engine.js`、`js/worker/pikafish-engine.wasm`、`nnue/pikafish-9e20a9a44415.nnue` |
| 是否修改 | **否**。这三个文件是官方源码经由 `scripts/build_wasm.sh` 用 Emscripten 交叉编译得到的产物，本项目的改造全部发生在包在它们外面的 `js/worker/pikafish.worker.js`，产物本身一字未动 |

**构建来源（可复现）**

- 引擎源码版本：upstream commit `97133eeb`，日期 `20260721`（见 `scripts/build_wasm.sh` 的 `OFFICIAL_SHA` / `OFFICIAL_DATE`）
- 编译方式：`emmake make ARCH=wasm32 COMP=gcc` + pthread / SharedArrayBuffer 多线程
- 编译产物校验：

  | 文件 | 大小 | SHA-256 |
  |---|---|---|
  | `pikafish-engine.wasm` | 696,055 B | `56159745c701f2a10c30cd1e585d04c03e90809dbf4d486eeeab94806e7aa120` |
  | `pikafish-engine.js` | 80,889 B | （见文件本身） |
  | `pikafish-9e20a9a44415.nnue` | 51,585,654 B | `3cd15292bf8c979884262f57fc723959fc0dea43b4d8d544f88db5ceb2479e24` |

- NNUE 权重来自官方网络发布节点（`scripts/net.sh` 所指向的 `official-pikafish/Networks`），
  文件名中的 `9e20a9a44415` 是官方网络 SHA-256 的前 12 位，用于版本追溯。

> GPL-3.0 要求分发二进制时提供对应源码的获取途径。上游源码地址见上表；
> 编译脚本见 `scripts/build_wasm.sh`；官方权重获取脚本见上游 `scripts/net.sh`。

---

## 2. Wukong — MIT

| 项 | 内容 |
|---|---|
| 作品 | Wukong —— JavaScript 中国象棋引擎 |
| 上游 | https://github.com/maksimKorzh/wukong-xiangqi （文件 `src/engine/wukong.js`） |
| 作者 | Maksym Korzh（"Code Monkey King"） |
| 许可 | **MIT License, Copyright (c) 2021 Maksym Korzh** |
| 本项目中的位置 | `js/engines/wukong/wukong.js` |
| 是否修改 | **引擎代码一字未动**。仅在该文件开头追加了一段注释块，用于载明 MIT 许可所要求的版权与许可声明 |

- 上游文件 SHA-256：`5615ada1a6a6428f4e665d547cb04d1bbc3baf8dea43ad88c3341e2a65e4689d`
- 校验方式：把 `js/engines/wukong/wukong.js` 去掉开头 17 行注释块后，
  应与其上游版本**字节级完全一致**。
- 本项目中的作用：难度档位 1~3 的算力来源（零下载、点开即玩）。

---

## 3. xiangqi.js — BSD-2-Clause

| 项 | 内容 |
|---|---|
| 作品 | xiangqi.js —— 中国象棋走法生成与合法性判定库 |
| 上游 | https://github.com/lengyanyu258/xiangqi.js |
| 作者 | Jeff Hlywa (jhlywa) & lengyanyu258 |
| 许可 | **BSD 2-Clause** |
| 本项目中的位置 | `js/xiangqi.js` |
| 是否修改 | **是**。新增了 `startFen` 记录、`findKing` / `isSquareAttacked` / `kingsFacing` /
  `inCheck` / `isLegalMoveFull`（补齐「白脸将」与「自杀着」判定）。原文件的版权头已保留 |

---

## 4. xiangqiboardjs — MIT

| 项 | 内容 |
|---|---|
| 作品 | xiangqiboardjs —— 中国象棋棋盘渲染库 |
| 上游 | https://github.com/lengyanyu258/xiangqiboardjs |
| 作者 | Chris Oakman & lengyanyu258 |
| 许可 | **MIT License** |
| 本项目中的位置 | `js/xiangqiboard.js` |
| 是否修改 | **是**。改为使用实例自身的局面引用（不再依赖全局 `window.gameInstance`）、
  落子提示改用 `isLegalMoveFull`、新增悔棋后的选中态清理与难度选择菜单分层。
  原文件的版权头已保留 |

---

## 5. 本项目原创且不依赖第三方声明的部分

以下文件由本项目（含其上游 `billzi2016/Chinese-Chess-AI-Pro`）自行编写，
按项目整体许可 GPL-3.0 分发，**不含**需要单独署名的第三方代码：

- `js/difficulty.js` — 难度档位定义与走子采样
- `js/engines/bridge.js` — 引擎可插拔抽象层
- `js/engines/wukong/wukong.worker.js` — Wukong 引擎的 Worker 包装
- `js/worker/pikafish.worker.js` — Pikafish 引擎的 Worker 包装（含权重缓存与进度上报）
- `coi-serviceworker.js` — 为静态托管注入 COOP/COEP 响应头
- `js/app.js`、`index.html`、`styles/**`、`server.py`、`scripts/build_wasm.sh`

> 关于 `coi-serviceworker.js`：它与社区知名的 `gzuidhof/coi-serviceworker` **不共享代码**
> （那是一份 146 行的通用实现，本文件是 33 行的独立精简实现，仅思路相同），
> 因此不归入第三方署名，按本项目 GPL-3.0 分发。

---

## 许可兼容性说明

- MIT / BSD-2-Clause 均为宽松许可，**可以**并入 GPL-3.0 项目，只需保留原始声明。
- GPL-3.0 与 GPL-3.0 兼容。
- 本项目**未**使用 GPL-2.0-only 的作品（例如 `xqbase/xqwlight`，
  GPL-2.0-only 与 GPL-3.0 不兼容），这也是低档位引擎最终选择 MIT 的 Wukong 而非 XQWLight 的原因。
