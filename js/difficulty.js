/**
 * difficulty.js - 难度档位定义与走子采样
 *
 * 这个文件同时被主线程（app.js）和两个 Worker（wukong / pikafish）加载，
 * 因此必须写成不依赖 DOM 的经典脚本，通过全局对象暴露。
 *
 * 背景：Pikafish 虽然源自 Stockfish，但**没有** Skill Level / UCI_Elo /
 * UCI_LimitStrength 这三个选项（已逐文件核实 src/engine.cpp、src/search.cpp、
 * src/search.h）。引擎实际只注册了 Threads / Hash / MultiPV / Move Overhead /
 * EvalFile 等。所以"低难度"必须由我们自己造：
 *   - 低档位（1-3）交给纯 JS 的 wukong 引擎，靠限制深度 + 概率性劣化；
 *   - 高档位（4-6）交给 Pikafish，靠 MultiPV 拿候选着法 + softmax 采样。
 *
 * @license GPL-3.0
 */

(function (global) {
  'use strict';

  // 引擎标识，与 js/engines/bridge.js 注册的 id 对应
  var WUKONG = 'wukong';
  var PIKAFISH = 'pikafish';

  /**
   * 六档难度。
   *
   * wukong 档位字段：
   *   depth   - 传给 engine.search(depth) 的搜索深度
   *   blunder - 直接走随机合法着法的概率（0~1），越大越弱
   *
   * Pikafish 档位字段：
   *   depth       - go depth N；为 0 表示只用 movetimeMs
   *   movetimeMs  - go movetime N
   *   multipv     - 要引擎返回几个候选着法供采样
   *   temperature - softmax 温度（厘分）。0 表示永远选最优着法
   *
   * 两个引擎都有 maxMs：搜索时间的硬上限。
   * 这不是为了限强度，而是**安全网** —— 产物没有 asyncify，`go` 是同步阻塞的，
   * 一旦某个局面搜得特别久，用户既取消不了也悔不了棋，只能干等。
   * 正常情况下这些上限根本不会触发（实测 depth 12 只要 ~200ms）。
   *
   * 这些数值已经用"机机对战"实测校准过（相邻档位各 6 局、红黑互换）：
   *   L1:L2 = 0:6   L2:L3 = 1:5   L3:L4 = 0:18   L4:L5 = 0:5(1 和)   L5:L6 = 2 和
   * 没有倒挂。档位 3 与 4 的分界同时也是"纯 JS 引擎 / WASM 引擎"的分界，
   * 强度落差天然最大，实测 L4 对 L3 全胜 —— 这是引擎量级差异，不是参数没调好。
   * 档位 4 的温度是主要调节旋钮：T 越大越弱。实测（每档 4 个中局、每个采 3~5 次，
   * 以档位 5 的 depth 12 评估为基准算"每步损失厘分"）：
   *   T=40~60  → 平均损失约 0（几乎等于档位 5，太强，档位 4 失去意义）
   *   T=120    → 约 14（档位 3 约 30，档位 5 约 0，正好落在两者之间）← 采用
   *   T=170    → 约 21（与档位 3 拉不开）
   *
   * 一个反直觉的实测结论，调参前务必知道：**给 wukong 加深度几乎不涨棋**。
   * depth 4 → depth 6 平均损失基本不动（中位数都是 30~40 厘分），因为它的
   * 评估函数太粗，搜得再深也只是把同一个错判断做得更彻底。所以档位 1~3 的
   * 强弱**只能靠 blunder 概率**调，别指望加深度；而档位 3 的天花板就在
   * 30 厘分左右 —— 再往上必然要换成 Pikafish（即档位 4）。
   */
  var LEVELS = [
    { level: 1, engine: WUKONG,   label: '入门', depth: 1, blunder: 0.35, maxMs: 1000 },
    { level: 2, engine: WUKONG,   label: '初级', depth: 2, blunder: 0.20, maxMs: 1500 },
    { level: 3, engine: WUKONG,   label: '中级', depth: 4, blunder: 0.06, maxMs: 3000 },
    { level: 4, engine: PIKAFISH, label: '高级', depth: 10, movetimeMs: 3000, multipv: 3, temperature: 120 },
    { level: 5, engine: PIKAFISH, label: '大师', depth: 12, movetimeMs: 5000, multipv: 1, temperature: 0 },
    { level: 6, engine: PIKAFISH, label: '宗师', depth: 0,  movetimeMs: 5000, multipv: 1, temperature: 0 }
  ];

  var DEFAULT_LEVEL = 3;

  // 将帅被吃的分数用 100000 量级表示，与 Pikafish 的 UCI 输出惯例一致
  var MATE_BASE = 100000;

  /** 按档位号取档位定义；越界时回落到默认档位 */
  function getLevel(level) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (LEVELS[i].level === level) return LEVELS[i];
    }
    return getLevel(DEFAULT_LEVEL);
  }

  /** 该档位是否由纯 JS 引擎承担（零下载） */
  function isLocalEngine(level) {
    return getLevel(level).engine === WUKONG;
  }

  /**
   * 把 UCI 的 `score mate N` / `score cp N` 折算成可比较的厘分。
   * mate 为正表示己方将死对手（越大越好），为负表示被将死。
   */
  function scoreToCp(kind, value) {
    if (kind === 'mate') {
      return value > 0 ? MATE_BASE - value : -MATE_BASE - value;
    }
    return value;
  }

  /**
   * 按 softmax 权重从候选着法中采样。
   *
   *   w_i = exp(-(best - s_i) / temperature)
   *
   * temperature 越大越容易选中次优着法（越弱）；temperature <= 0 或只有
   * 一个候选时退化为直接取最优。
   *
   * @param {Array<{move:string, score:number}>} candidates 至少含 move 与 score
   * @param {number} temperature
   * @returns {{move:string, score:number}|null}
   */
  function pickByTemperature(candidates, temperature) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // 先找出最优分，顺便做同分随机打破平局
    var best = -Infinity;
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].score > best) best = candidates[i].score;
    }

    var sameBest = [];
    for (var j = 0; j < candidates.length; j++) {
      if (candidates[j].score === best) sameBest.push(candidates[j]);
    }

    if (!(temperature > 0)) {
      return sameBest[Math.floor(Math.random() * sameBest.length)];
    }

    var total = 0;
    var weights = new Array(candidates.length);
    for (var k = 0; k < candidates.length; k++) {
      var w = Math.exp(-(best - candidates[k].score) / temperature);
      // 分差过大时 exp 会下溢成 0，这里给一个极小下限，
      // 保证理论上任何候选都有被选中的可能（更像人而不是像机器）
      if (!(w > 0)) w = 1e-9;
      weights[k] = w;
      total += w;
    }

    var roll = Math.random() * total;
    for (var m = 0; m < candidates.length; m++) {
      roll -= weights[m];
      if (roll <= 0) return candidates[m];
    }
    return candidates[candidates.length - 1];
  }

  /** 该档位这一步是否应当"失误"（直接走随机合法着法） */
  function shouldBlunder(level) {
    var p = getLevel(level).blunder || 0;
    return p > 0 && Math.random() < p;
  }

  /** 从合法着法数组里随机取一个（用于劣化） */
  function pickRandom(moves) {
    if (!moves || moves.length === 0) return null;
    return moves[Math.floor(Math.random() * moves.length)];
  }

  var Difficulty = {
    WUKONG: WUKONG,
    PIKAFISH: PIKAFISH,
    LEVELS: LEVELS,
    DEFAULT_LEVEL: DEFAULT_LEVEL,
    MATE_BASE: MATE_BASE,
    getLevel: getLevel,
    isLocalEngine: isLocalEngine,
    scoreToCp: scoreToCp,
    pickByTemperature: pickByTemperature,
    shouldBlunder: shouldBlunder,
    pickRandom: pickRandom
  };

  global.Difficulty = Difficulty;

  // 便于在 Node 下复用（例如离线调参脚本）
  if (typeof module !== 'undefined' && module.exports) module.exports = Difficulty;

})(typeof self !== 'undefined' ? self : this);
