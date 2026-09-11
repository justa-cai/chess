# CLAUDE.md

中国象棋 AI 网页应用。**纯静态**——没有构建步骤、没有依赖安装、没有测试框架，
改完文件刷新浏览器即生效。

---

## 快速命令

```bash
python3 server.py          # 本地开发服务器，http://127.0.0.1:6324/
```

必须先起服务器（或任何能发 COOP/COEP 响应的 HTTP 服务）再打开页面。
`file://` 拿不到跨源隔离，Pikafish 的多线程路径起不来（档位 1~3 不受影响）。

---

## 架构

```
index.html
  └─ js/xiangqiboard.js   棋盘渲染 + 三级菜单遮罩（视图）
     js/app.js            对局流程、轮次、终局判定、侧栏统计（控制）
        └─ js/engines/bridge.js        引擎可插拔门面（load/unload/search/status）
             ├─ js/engines/wukong/wukong.worker.js  → 档位 1~3，零下载
             └─ js/worker/pikafish.worker.js        → 档位 4~6，49MB 权重
                  └─ pikafish-engine.js + .wasm + nnue/*.nnue   ← 一律不要改
  js/difficulty.js        档位表 + 走子采样，**主线程与两个 Worker 都加载它**
```

`difficulty.js` 是"难度"的单一事实来源。改档位参数只改这一个文件，
三个运行环境（主线程 / wukong worker / pikafish worker）自动同步。

---

## 改这个仓库前必须知道的硬约束

每一条都对应一个踩过的坑。**不要凭直觉绕过它们。**

### 1. 不要改 `pikafish-engine.js` / `pikafish-engine.wasm`

那是 Emscripten 构建产物（`pikafish-engine.js` 整个文件只有 **1 行** 80KB）。
`scripts/build_wasm.sh` 依赖 `third-party/pikafish/src`，而 `third-party/` 被
`.gitignore` 排除、**仓库里并不存在** —— 也就是说这个文件**无法重新生成**，手改
就永久性地偏离了官方源码。

所有改造都发生在包在它外面的 `js/worker/pikafish.worker.js` 里。
产物本身一字未动（`NOTICE.md` 有校验和可以证明）。

**连"加一行 console.log"都别做。**

### 2. `pikafish.worker.js` 必须与 `pikafish-engine.js` 同在 `js/worker/`

pre-js 用 `new URL("../../nnue/pikafish-*.nnue", self.location.href)` 定位权重，
而 `self.location.href` 是**包装层脚本**的 URL，不是 `pikafish-engine.js` 的。
把包装层挪到别的目录深度（比如 `js/engines/pikafish/`）→ 路径解析成 `/js/nnue/...`
→ 权重 404。`nnue/` 目录同理不能移。

### 3. pthread 池守卫（漏了就是 N×49MB）

`PThread.allocateUnusedWorker()` 执行的是 `new Worker(_scriptName, {name:"em-pthread"})`，
而 `_scriptName` 就是**包装层自己的 URL** —— 包装层会被线程池里每个 worker 再执行一遍。
不加守卫，16 核机器就是 16 份 49MB 下载。

`js/worker/pikafish.worker.js` 顶部的 `if (self.name === 'em-pthread')` 分支就是干这个的，
删掉或调换顺序都会坏。

### 4. 自定义消息类型不能撞 pre-js 内建的 5 种

内建 `handleIncomingMessage` 认：`INIT` / `SEARCH` / `VALIDATE` / `STATUS` / `STOP`
（**没有 else 分支**，未知类型静默忽略）。所以包装层刻意改用
`INIT_ENGINE` / `SEARCH_LEVEL` / `POSITION_STATUS` / `STOP_SEARCH` / `UCI_CMD`。

两个 listener 并存是设计使然，不是 bug —— 靠"名字不重叠"实现互不干扰。
**新增消息时务必避开上面那 5 个名字。**

反方向也要注意：内建层收到 `bestmove` 会抢先发一条**不带 seq** 的 `BEST_MOVE`。

### 5. bridge 只认带 seq 的回复

`js/engines/bridge.js` 里所有 `BEST_MOVE` / `POSITION_STATUS_RESULT` / `VALIDATION_RESULT`
的分支都先判 `data.seq` 是否存在。这条过滤是**难度采样能生效的前提**：
内建层那条不带 seq 的是"引擎首选着法"，放进来就等于绕过了档位采样。

### 6. `wukong.js` 与上游逐字节一致

`js/engines/wukong/wukong.js` = 上游 `maksimKorzh/wukong-xiangqi` 的
`src/engine/wukong.js`（SHA256 `5615ada1a6a6428f...`），**只在文件最前面加了 17 行
MIT 署名注释**。要改行为就改 `wukong.worker.js`（比如静音 `console.log` 就是在
wrapper 里做的），不要动引擎本体。

校验方式：

```python
up = open('上游副本','rb').read()
cur = open('js/engines/wukong/wukong.js','rb').read()
print(cur[cur.find(up):] == up)   # True
```

### 7. `nnue/*.nnue` 必须入库，不能加进 `.gitignore`

49.19 MiB，GitHub 单文件硬上限 100 MiB，能过。**但这是刻意的**：
GitHub Pages 直接从仓库提供该文件，排除了它整站就没法用。

不要为了"让仓库小一点"把它 gitignore 掉或挪去 LFS。

### 8. 许可证是 GPL-3.0，而且是**传染性**的

Pikafish 是 GPL-3.0，编译成 WASM 后随前端一起分发 → 整个产物都是 GPL-3.0。

**不能引入 GPL-2.0-only 的代码**（GPL-2.0-only 与 GPL-3.0 不兼容）。
这就是当初低档位引擎选 MIT 的 Wukong、而**没有**选 star 更多的
`xqbase/xqwlight`（GPL-2.0-only）的原因。新增第三方代码前先确认许可证。

### 9. 部署只能用 GitHub Pages

| 平台 | 单文件上限 | 能否放下 49MB 权重 |
|---|---|---|
| GitHub Pages | 100 MiB | ✅ |
| Cloudflare Pages | **25 MiB** | ❌ |

另外 gzip 对权重完全无效（51,585,654 → 51,592,983 字节，反而变大），
**49MB 就是真实传输量**，唯一的杠杆是缓存。

---

## 引擎协议速查

| 方向 | 类型 | 说明 |
|---|---|---|
| bridge → pikafish | `INIT_ENGINE` | 触发 `uci` 握手 |
| | `SEARCH_LEVEL` | `{fen, startFen, moves, level}` |
| | `POSITION_STATUS` | 只要合法着法数，不走搜索 |
| | `STOP_SEARCH` | **实际中断不了**，见下 |
| bridge → wukong | `INIT_ENGINE` / `SEARCH_LEVEL` / `POSITION_STATUS` | 同名字，实现不同 |
| worker → bridge | `READY` | **不做 seq 校验**（内建层与包装层各发一条，先到先算） |
| | `BEST_MOVE` | `{seq, move, legalMoves, info}`；`move === '(none)'` 即终局 |
| | `POSITION_STATUS_RESULT` | `{seq, count}`，`count === 0` 判负 |
| | `LOAD_PROGRESS` / `LOAD_STAGE` / `ERROR` | 加载期事件 |

**`STOP_SEARCH` 是假的。** 产物没有 asyncify，`go` 在上游是**同步阻塞**的，
`stop` 只能排在当前搜索结束后才被消费。真正的中断手段是把 `movetime` 封顶
（`difficulty.js` 里的 `maxMs`），所以别指望"用户点了取消就立刻停"。

### `position` 命令的坑

发给引擎的必须是 `position fen <startFen> moves <全部着法>`，
**不能**写成 `position fen <当前FEN> moves <全部着法>` —— 后者会把所有着法
在已经走完的局面之上再走一遍，等于给引擎喂非法着法。
这条同时让引擎能看到重复局面，避免长将循环。

---

## 难度调参

### 档位表（`js/difficulty.js`）

| 档位 | 引擎 | 关键参数 |
|---|---|---|
| 1 入门 | wukong | `depth 1`, `blunder 0.35` |
| 2 初级 | wukong | `depth 2`, `blunder 0.20` |
| 3 中级 | wukong | `depth 4`, `blunder 0.06` |
| 4 高级 | Pikafish | `depth 10`, `movetime 3000`, `multipv 3`, `temperature 120` |
| 5 大师 | Pikafish | `depth 12`, `movetime 5000`, `multipv 1`, `temperature 0` |
| 6 宗师 | Pikafish | `movetime 5000`（不设 depth） |

**Pikafish 没有难度选项。** 逐文件核实过 `src/engine.cpp`、`src/search.cpp`、
`src/search.h`：**没有** `Skill Level`，也没有 `UCI_Elo` / `UCI_LimitStrength`
（全仓库搜 `UCI_Elo` 命中 0；`Skill` 只在 `tests/instrumented.py` 那个从
Stockfish 继承来的**失效测试**里出现 —— UCI 对未知选项静默忽略，所以它照常"通过"）。

档位 4 的"弱"是自己造的：`MultiPV` 拿多个候选着法 → 厘分 softmax 温度采样
（`w_i = exp(-(best - s_i) / T)`）。

### 两条反直觉的实测结论

1. **给 wukong 加深度几乎不涨棋。** depth 4 → depth 6 平均损失基本不动
   （中位数都是 30~40 厘分）—— 它的评估函数太粗，搜得再深只是把同一个错判断
   做得更彻底。**档位 1~3 的强弱只能靠 `blunder` 概率调。**
   档位 3 的天花板就在 30 厘分左右，再往上必须换引擎（即档位 4）。

2. **温度太低会让档位 4 失去意义。** 初版用 `depth 6 + T90`，实测比档位 3 **还弱**
   （搜索越浅 MultiPV 候选分的噪声越大，采样越容易选中真正的坏棋）。
   `T=40~60` 时又几乎等于档位 5。**T120 是扫出来的甜点。**

### 怎么量（三层验证法，调参必做）

不要只看单次对局的观感。按下面的顺序：

**第一层 · 头对头（最稳健，作为最终判据）**
相邻档位各跑 6 局，红黑互换，看胜负。基线：

```
1:2 = 0:6    2:3 = 1:5    3:4 = 0:18    4:5 = 0:5(1和)    5:6 = 2和
```

**第二层 · 每步损失厘分（看出"弱在哪"）**
取若干真实中局局面，以档位 5（depth 12）的评估为基准：

```
损失 = 该局面最优评估 − 走完所走着法后的评估   （行棋方视角）
```

注意**以中位数和头对头为准，不要按平均值微调** —— 单次采样的方差很大，
"送不送子"取决于随机劣化有没有触发。

**第三层 · 侧栏真实统计**
depth / nodes / NPS / score 全来自引擎的 UCI 输出，可用来交叉印证。

### 怎么跑这套实验（不需要新建任何文件）

用 `playwright-cli` 直接在主页面里驱动 `EngineBridge`——它已经是全局对象，
`Xiangqi`、`Difficulty` 同理：

```bash
playwright-cli attach --cdp=http://localhost:<PORT> --s=xq
playwright-cli --s=xq eval "(async () => {
  const r = await EngineBridge.search('pikafish', { fen: '...', level: 4 });
  return JSON.stringify(r);
})()"
```

对局推进用 `new Xiangqi()` + `game.applyUciMove(mv)` + `game.fen()`。
想换档位参数改 `difficulty.js` 后 `goto` 一次页面即生效（**没有 `no-store`
之外的热更新机制，必须重新加载**）。

---

## 规则层

`js/xiangqi.js` 源自 `lengyanyu258/xiangqi.js`（BSD-2），本项目做了扩展：

| 方法 | 用途 |
|---|---|
| `isLegalMove` | **只判几何走法**（别马腿、塞象眼、炮翻山、九宫限制）。**不判**白脸将与自杀着 |
| `isLegalMoveFull` | 试走 → 检查 → 回滚。含白脸将与自杀着。**落子提示与人类落子都用它** |
| `inCheck` / `findKing` / `kingsFacing` / `isSquareAttacked` | 上面那个的支撑 |
| `applyMove` / `undo` | 执行与回滚，`undo` 直接服务于悔棋 |

### 终局判定

`xiangqi.js` 里**没有** `in_checkmate` / `in_stalemate`。终局一律靠引擎报的
**合法着法数**：`EngineBridge.status()` 或 `SEARCH_LEVEL` 回包里的 `legalMoves`
为 **0** 即被将死或困毙 —— 象棋里无子可走即判负。

PvP 模式下 `app.js` 用 **wukong** 来做终局判定，避免为了判个胜负去下 49MB。

### 引擎着法必须复核

`app.js` 的 `applyEngineMove()` 会用 `game.isLegalMoveFull()` 再验一遍引擎给的着法，
不合法就明确报错，**不静默卡死**。

---

## 缓存策略

### 开发服务器（`server.py`）

按扩展名分流（`IMMUTABLE_EXTENSIONS = (".nnue", ".wasm")`）：

- `*.nnue` / `*.wasm` → `public, max-age=31536000, immutable`
  （nnue 文件名含官方网络 SHA 前缀，内容变则文件名变，immutable 安全）
- 其余（HTML/JS/CSS）→ `no-store`，保证改完刷新即见
- COOP/COEP **所有响应都加**

### 浏览器侧

`pikafish.worker.js` 用 `self.fetch` 垫片拦 `.nnue`：

- 三层查找：会话内内存 `nnueBytesPromise` → Cache Storage → 网络
- Cache Storage 只是**跨会话**的兜底，内存那份才是"本次会话绝不下第二次"的保证
  （否则 pre-js 内部那次 fetch 可能赶在 `cache.put` 落盘之前发起 → 49MB 下两遍）
- 垫片**只拦 `.nnue`**。`.wasm` 必须原样透传 —— 流式编译需要真实的
  `application/wasm` 响应，合成响应会让 `instantiateStreaming` 失败
- Cache Storage 不可用/超配额时**降级到直接网络请求**，绝不能因此白屏

---

## 样式

`styles/` 走 Design Tokens 体系（`tokens.css` 定义变量）。
**新增样式不要硬编码颜色**，用既有 token。

---

## 已知边界与待办

- **移动端未实测**（没有设备）。风险点是 `pikafish-engine.js` 里硬编码的
  `setoption name Hash value 256`（256MB 置换表）+ 49MB 权重共用一个 WASM 堆。
  包装层 `applyMemoryCap()` 已在 `navigator.deviceMemory <= 4`（GB）时把这条
  命令改写成 64MB，但**低端手机仍建议只用 1~3 档**。
- **档位 3 → 4 之间是最大的强度断层**（实测 0:18）。这是"JS 引擎 / WASM 引擎"
  的分界，属引擎量级差异，不是参数问题。要填平就得再做一个纯 JS 或更深度的档位。
- `specs/` 三份文档的时效性**不一致**，别当成现况来读：
  - `specs/prd.md` —— **已更新**，双引擎、六档难度、UCI 协议表、GPL-3.0 都是当前实现
  - `specs/ui.md` —— 上游原文，**已过时**（比如它写悔棋按钮在 `#game-summary` 里，
    实际在 `#ai-controls`，id 也从 `#restartbtn` 换成了 `#restart-btn`）
  - `specs/project_tree.md` —— 上游原文，**已过时**（完全没有 `difficulty.js` /
    `bridge.js` / `engines/wukong/` 这些新文件）

  有疑问时**以代码和 README 为准**，`specs/` 只当背景资料。
- 仓库里没有 `test/`，也没有建测试框架的打算 —— 验证靠上面的"三层验证法"
  在真实浏览器里跑。
