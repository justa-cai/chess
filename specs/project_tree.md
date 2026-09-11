# 项目目录结构说明 (Project Tree Specification)

## 1. 完整目录树

```text
Chinese-Chess-AI/
├── specs/                   # 项目规格与需求文档 (SDD 模式专用)
│   ├── prd.md               # 产品需求文档 (PRD)
│   ├── ui.md                # UI 界面与交互设计规范 (参考 ui_example)
│   └── project_tree.md      # 本文件: 项目目录结构说明
├── third-party/             # 第三方开源依赖与引擎源代码
│   ├── pikafish/            # Pikafish (C++17) 引擎源码与 Emscripten 适配桥接 (GPLv3)
│   ├── xiangqi.js/          # 象棋规则库 (BSD-2-Clause)
│   └── xiangqiboardjs/      # 棋盘渲染库 (MIT)
├── styles/                  # 模块化 CSS 设计系统 (Design Tokens 架构)
│   ├── tokens.css           # 变量定义 (颜色、尺寸、动画、间距)
│   ├── base.css             # 基础与重置样式 (Reset & Typography)
│   ├── components/          # 组件局部样式
│   └── main.css             # 样式统一入口 (@import 汇总)
├── js/                      # 业务逻辑与核心模块
│   ├── xiangqiboard.js      # 棋盘 UI 渲染与拖拽/点击动画交互
│   ├── xiangqi.js           # 中国象棋规则裁判库 (合法性校验、FEN 维护)
│   ├── worker/              # Web Worker 算力桥接
│   │   ├── pikafish-engine.js   # Pikafish 多线程 WASM 线程入口与适配桥接
│   │   ├── pikafish-engine.wasm # 编译后的 Pikafish C++17 算力核心
│   │   └── pikafish.nnue        # 51MB 官方 NNUE 神经网络评估权重
│   └── app.js               # 主应用入口，装配 UI、裁判与 Worker
├── test/                    # 自动化测试套件
│   ├── test_pikafish_browser.py # Playwright Chromium 真实浏览器集成测试
│   └── run_tests.sh         # 测试全量入口
├── coi-serviceworker.js     # GitHub Pages 环境支持 SharedArrayBuffer 的跨源隔离 SW
├── scripts/
│   └── build_wasm.sh        # Pikafish pthread WASM 交叉编译脚本
├── server.py                # 本地多进程开发服务器 (注入 COOP/COEP)
├── index.html               # Web 页面主入口 (HTML5 语义化)
├── LICENSE                  # GNU General Public License v3.0 (GPLv3)
├── README.md                # 英文项目介绍与开源声明
└── README_CN.md             # 中文项目介绍与开源声明
```

---

## 2. 核心模块与职责分工

### 2.1 需求规范 (`specs/`)
* **`prd.md`**：产品需求定义，涵盖零后端架构、5秒思考算力、CSS系统与UCI协议。
* **`ui.md`**：UI 界面与交互设计规范，详细定义页面组件、多级菜单遮罩与侧边 AI 评估面板。
* **`project_tree.md`**：说明代码规范与目录划分。

### 2.2 依赖与引擎 (`third-party/`)
* **`third-party/pikafish/`**：Pikafish 顶级象棋引擎开源 C++ 源码。

### 2.3 业务逻辑层 (`js/`)
* **`xiangqiboard.js`**：DOM 渲染与用户交互响应。
* **`xiangqi.js`**：象棋着法生成器与规则转换。
* **`worker/`**：多线程 WASM 密集计算与 NNUE 加载，避免阻塞主 UI 线程。
