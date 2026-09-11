/**
 * wukong.worker.js - 低档位纯 JS 引擎的 Worker 包装
 *
 * 为什么必须放在 Worker 里：wukong 的 `search(depth)` 是**同步阻塞**的
 * 深度优先搜索，放在主线程会直接冻结界面（棋盘、动画、按钮全卡住）。
 * 放进 Worker 后主线程只负责收发消息，始终维持 60fps。
 *
 * 与 bridge 的消息契约（与 pikafish.worker.js 保持一致）：
 *   收: {type:'INIT_ENGINE'}
 *       {type:'SEARCH_LEVEL', seq, fen, level}
 *       {type:'STOP_SEARCH', seq}
 *   发: {type:'READY', engine:'wukong'}
 *       {type:'BEST_MOVE', seq, move, info}   move 为 UCI 坐标如 "h2e2"，
 *                                             无着可走时为 "(none)"
 *       {type:'ERROR', seq, message}
 *
 * 坐标格式：wukong 的 COORDINATES 表就是 `a0`~`i9`（rank 0 在下、rank 9 在上，
 * file a~i 从左到右），与 Pikafish 的 UCI 坐标**完全一致**，无需转换。
 * 这一点已逐格对照过两边的坐标表。
 *
 * @license GPL-3.0
 */

'use strict';

importScripts('wukong.js');
importScripts('../../difficulty.js');

// wukong.js 每搜一层就往 console.log 打一行 `info ...`、搜完再打一行 `bestmove`，
// 一局下来能把控制台刷爆（引擎在 Worker 里，这些日志对用户毫无意义）。
// 这里只把 console.log 静音，**不动引擎源码** —— 保持 wukong.js 与上游逐字节一致
// （见 NOTICE.md 的校验方式）。console.warn / console.error 原样保留，
// 真出问题仍然看得见；对外的错误通道始终是 postMessage({type:'ERROR'})。
console.log = function () {};

// 0 号格是 11x14 邮箱棋盘外的哨兵（OFFBOARD），任何落在 0 的着法都无效
var OFFBOARD_SQUARE = 0;

var engine = Engine();

/** 把引擎内部的着法整数转成 UCI 坐标串；无效着法返回 null */
function toUciMove(move) {
  if (!move) return null;
  var from = engine.getSourceSquare(move);
  var to = engine.getTargetSquare(move);
  if (from === OFFBOARD_SQUARE || to === OFFBOARD_SQUARE) return null;
  var text = engine.moveToString(move);
  if (text.indexOf('xx') >= 0) return null;
  return text;
}

/** 取当前局面的全部合法着法（整数形式） */
function legalMoves() {
  var entries = engine.generateLegalMoves();
  var moves = [];
  for (var i = 0; i < entries.length; i++) {
    if (entries[i] && entries[i].move) moves.push(entries[i].move);
  }
  return moves;
}

function handleSearch(data) {
  var level = Difficulty.getLevel(data.level);
  var started = Date.now();

  engine.setBoard(data.fen);
  engine.resetSearchPly();

  // 终局：无合法着法（被将死或困毙）。返回 (none) 交给主线程判负，
  // 不能让引擎带着空着法表往下搜。
  var moves = legalMoves();
  if (moves.length === 0) {
    return { move: '(none)', legalMoves: 0, info: null };
  }

  // 低档位劣化：按概率直接走一个随机合法着法。
  // 这比单纯降低搜索深度更可控 —— 深搜的引擎即使只搜 1 层也会"贪吃"
  // 到不犯低级错误，反而显得不像新手。
  var chosen = null;
  if (Difficulty.shouldBlunder(level.level)) {
    chosen = Difficulty.pickRandom(moves);
  }

  // 没有劣化就正常搜索
  if (!chosen) {
    engine.resetSearchPly();
    // 时间上限是安全网：wukong 是同步搜索，中局 depth 4~6 理论上可能搜很久。
    // setTimeControl 会整体替换 timing 对象，四个字段都得给 ——
    // 其中 timeSet 必须为 1、time 不能是 -1，否则时间判定不会生效。
    if (level.maxMs) {
      engine.setTimeControl({
        timeSet: 1,
        stopTime: Date.now() + level.maxMs,
        stopped: 0,
        time: level.maxMs
      });
    }
    var best = engine.search(level.depth);
    var uci = toUciMove(best);
    if (!uci) {
      // 引擎没给出有效着法（极罕见的搜索异常），退回到随机合法着法保底，
      // 避免整个对局卡死
      chosen = Difficulty.pickRandom(moves);
    } else {
      return {
        move: uci,
        legalMoves: moves.length,
        // 只上报真实数据：depth 是我们要求的、time 是我们量的。
        // wukong 没有向 Worker 暴露 nodes/nps/score，就不编造。
        info: { depth: level.depth, time: Date.now() - started }
      };
    }
  }

  return {
    move: toUciMove(chosen) || '(none)',
    legalMoves: moves.length,
    info: { depth: 0, time: Date.now() - started }
  };
}

self.addEventListener('message', function (event) {
  var data = event.data || {};

  if (data.type === 'INIT_ENGINE') {
    self.postMessage({ type: 'READY', engine: 'wukong' });
    return;
  }

  if (data.type === 'SEARCH_LEVEL' || data.type === 'SEARCH') {
    try {
      var result = handleSearch(data);
      self.postMessage({
        type: 'BEST_MOVE',
        seq: data.seq,
        move: result.move,
        legalMoves: result.legalMoves,
        info: result.info
      });
    } catch (err) {
      self.postMessage({
        type: 'ERROR',
        seq: data.seq,
        message: (err && err.message) ? err.message : String(err)
      });
    }
    return;
  }

  // 终局判定：给一个局面，回它的合法着法数
  if (data.type === 'POSITION_STATUS') {
    var count = null;
    try {
      engine.setBoard(data.fen);
      engine.resetSearchPly();
      count = legalMoves().length;
    } catch (err) {
      count = null;
    }
    self.postMessage({ type: 'POSITION_STATUS_RESULT', seq: data.seq, count: count });
    return;
  }

  // wukong 的搜索是同步的，一旦进入 search() 就无法中断。
  // 低档位搜索很快（毫秒级），这里只是把协议补全，不做实质处理。
  if (data.type === 'STOP_SEARCH') {
    return;
  }
});
