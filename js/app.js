/**
 * app.js - 主应用装配与 UI 交互控制器
 *
 * 与改造前最大的区别：
 * · 不再直接 new Worker，而是通过 EngineBridge 走"引擎可插拔"接口；
 * · 不再有硬编码的"开局 12 秒 / 中后期 6 秒"，思考参数完全由难度档位决定；
 * · 人类落子用本地完整规则校验（isLegalMoveFull，含白脸将与自杀着），
 *   即时反馈，不再为了"这步合不合法"等一个 Worker 往返；
 * · 终局由引擎报出的合法着法数判定（0 即无子可走判负）——
 *   xiangqi.js 里根本没有 in_checkmate/in_stalemate，原先的判负分支永远不会触发；
 * · 新增悔棋（PvE 下连撤两步：AI + 玩家）。
 *
 * @license GPL-3.0
 */

document.addEventListener('DOMContentLoaded', function () {
  var LEVEL_STORAGE_KEY = 'xiangqi_level';
  var COLOR_RED = 'r';
  var COLOR_BLACK = 'b';

  var game = new Xiangqi();
  var board = null;
  var gameMode = 'pve';        // 'pve' | 'pvp' | 'eve'
  var playerSide = COLOR_RED;
  var currentLevel = readStoredLevel();
  var thinking = false;
  var lastMove = null;
  // 代数号：开局/悔棋/换局时自增，用来作废在途的引擎回包，
  // 避免"上一局的结果落到了这一局的棋盘上"。
  var turnToken = 0;

  // -------------------------------------------------------------------------
  // DOM 引用
  // -------------------------------------------------------------------------
  var statusEl = document.getElementById('ai-current');
  var levelBadgeEl = document.getElementById('level-badge');
  var progressWrapEl = document.getElementById('engine-progress');
  var progressBarEl = document.getElementById('engine-progress-bar');
  var progressTextEl = document.getElementById('engine-progress-text');
  var summaryEl = document.getElementById('game-summary');
  var summaryTextEl = document.getElementById('game-summary-text');
  var statsBodyEl = document.getElementById('ai-stats-body');

  // -------------------------------------------------------------------------
  // 基础工具
  // -------------------------------------------------------------------------

  function readStoredLevel() {
    try {
      var raw = window.localStorage.getItem(LEVEL_STORAGE_KEY);
      var parsed = parseInt(raw, 10);
      if (parsed >= 1 && parsed <= 6) return parsed;
    } catch (err) { /* 隐私模式下 localStorage 不可用，忽略 */ }
    return Difficulty.DEFAULT_LEVEL;
  }

  function storeLevel(level) {
    try { window.localStorage.setItem(LEVEL_STORAGE_KEY, String(level)); } catch (err) { /* 同上 */ }
  }

  function sideLabel(color) {
    return color === COLOR_RED ? '红方' : '黑方';
  }

  function opponent(color) {
    return color === COLOR_RED ? COLOR_BLACK : COLOR_RED;
  }

  function engineOf(level) {
    return Difficulty.getLevel(level).engine;
  }

  /**
   * 本局实际使用的引擎。人人对战不需要 AI 搜索，只需一个能算合法着法数
   * 的引擎做终局判定，用零下载的本地引擎即可 —— 避免为了 PvP 去下 49MB。
   */
  function engineForPlay() {
    return gameMode === 'pvp' ? Difficulty.WUKONG : engineOf(currentLevel);
  }

  function effectiveLevel() {
    return gameMode === 'pvp' ? Difficulty.DEFAULT_LEVEL : currentLevel;
  }

  function historyUcci() {
    var moves = [];
    for (var i = 0; i < game.history.length; i++) moves.push(game.history[i].ucci);
    return moves;
  }

  function setStatus(text) {
    if (statusEl) statusEl.innerText = text;
  }

  function updateLevelBadge() {
    if (!levelBadgeEl) return;
    var level = Difficulty.getLevel(currentLevel);
    levelBadgeEl.innerText = '难度：' + level.label +
      (gameMode === 'pvp' ? '（人人对战不适用）' : '');
  }

  // -------------------------------------------------------------------------
  // 引擎事件
  // -------------------------------------------------------------------------

  EngineBridge.configure({
    onProgress: function (p) {
      showProgress();
      var percent = Math.round(p.ratio * 100);
      if (progressBarEl) progressBarEl.style.width = percent + '%';
      if (progressTextEl) {
        progressTextEl.innerText = '正在下载神经网络权重 ' +
          Math.round(p.loaded / 1048576) + ' / ' + Math.round(p.total / 1048576) + ' MB（' + percent + '%）' +
          '　仅首次需要';
      }
    },
    onStage: function (s) {
      if (s.stage === 'ready') {
        hideProgress();
      } else {
        showProgress();
        if (progressTextEl) {
          if (s.stage === 'cached') {
            progressTextEl.innerText = '已命中本地缓存，正在读取神经网络权重…';
          } else if (s.stage === 'weights') {
            progressTextEl.innerText = '正在准备引擎…';
          } else {
            progressTextEl.innerText = '正在初始化引擎…';
          }
        }
      }
    },
    onError: function (e) {
      hideProgress();
      setStatus('引擎错误（' + e.engine + '）：' + e.message);
    }
  });

  function showProgress() {
    if (progressWrapEl) progressWrapEl.classList.remove('hide');
  }

  function hideProgress() {
    if (progressWrapEl) progressWrapEl.classList.add('hide');
    if (progressBarEl) progressBarEl.style.width = '0%';
  }

  // 本地引擎（wukong，57KB）页面加载就预热，之后切到 1~3 档是瞬时的。
  EngineBridge.load(Difficulty.WUKONG).catch(function () {
    // 预热失败不在这里报错，等真正开局时再提示，避免一进页面就弹错误
  });

  // -------------------------------------------------------------------------
  // 棋盘
  // -------------------------------------------------------------------------

  board = new XiangqiBoard('board-container', {
    onMove: function (from, to) {
      handleHumanMove(from, to);
    }
  });
  board.render(game);

  // -------------------------------------------------------------------------
  // 开局
  // -------------------------------------------------------------------------

  window.onGameStart = function (mode, side, level) {
    gameMode = mode;
    playerSide = side || COLOR_RED;
    if (level) currentLevel = level;
    storeLevel(currentLevel);

    turnToken += 1;
    game = new Xiangqi();
    board.selectedSq = null;
    board.lastMove = null;
    lastMove = null;
    thinking = false;

    if (summaryEl) summaryEl.classList.add('hide');
    board.render(game);
    updateRoleBadges();
    updateLevelBadge();
    clearStatsTable();

    // 高档位依赖 pthread + SharedArrayBuffer，必须在跨源隔离环境里才能跑。
    // 静态托管下这个环境由 coi-serviceworker.js 提供，而它首次注册后会强制
    // reload 一次，在那之前选高档位必然失败 —— 提前说清楚，不要让用户干等。
    if (engineForPlay() === Difficulty.PIKAFISH && !EngineBridge.supportsThreadedWasm()) {
      setStatus('当前环境不支持多线程 WebAssembly，正在准备中。请稍候刷新后重试，或改选 1~3 档。');
      return;
    }

    setStatus('正在准备引擎…');
    EngineBridge.load(engineForPlay())
      .then(function () {
        hideProgress();
        beginTurn();
      })
      .catch(function (err) {
        hideProgress();
        setStatus('引擎加载失败：' + err.message + '　可改选 1~3 档（内置引擎，无需下载）。');
      });
  };

  function updateRoleBadges() {
    var blackEl = document.getElementById('black-score');
    var redEl = document.getElementById('red-score');
    if (!blackEl || !redEl) return;

    if (gameMode === 'eve') {
      blackEl.textContent = 'AI';
      redEl.textContent = 'AI';
    } else if (gameMode === 'pvp') {
      blackEl.textContent = '玩家';
      redEl.textContent = '玩家';
    } else if (playerSide === COLOR_RED) {
      blackEl.textContent = 'AI';
      redEl.textContent = '玩家';
    } else {
      blackEl.textContent = 'AI 先手';
      redEl.textContent = '玩家';
    }
  }

  // -------------------------------------------------------------------------
  // 回合驱动
  // -------------------------------------------------------------------------

  function isAiTurn() {
    if (gameMode === 'eve') return true;
    if (gameMode === 'pve') return game.turn !== playerSide;
    return false;
  }

  function beginTurn() {
    if (isAiTurn()) {
      requestAiMove();
      return;
    }

    setStatus('轮到' + sideLabel(game.turn) + '走子。');

    // 人类回合也要确认"还有没有合法着法"。象棋里无子可走即判负
    // （不存在国际象棋那种困毙和棋），这是对局唯一的正常结束途径。
    var token = turnToken;
    EngineBridge.status(engineForPlay(), game.fen())
      .then(function (count) {
        if (token !== turnToken) return;   // 局面已经变了，这个结果作废
        if (count === 0) {
          finishGame(sideLabel(opponent(game.turn)) + '胜！' + sideLabel(game.turn) + '无子可走（将死或困毙）');
        }
      })
      .catch(function (err) {
        if (token !== turnToken) return;
        setStatus('引擎错误：' + err.message);
      });
  }

  function requestAiMove() {
    if (thinking) return;
    thinking = true;
    setStatus(engineLabelForStatus() + '思考中…');

    var fen = game.fen();
    var moves = historyUcci();
    var token = turnToken;

    EngineBridge.search(engineForPlay(), {
      fen: fen,
      startFen: game.startFen,
      level: effectiveLevel(),
      moves: moves
    })
      .then(function (result) {
        thinking = false;
        if (token !== turnToken) return;

        if (result.legalMoves === 0 || result.move === '(none)') {
          finishGame(sideLabel(opponent(game.turn)) + '胜！' + sideLabel(game.turn) + '无子可走（将死或困毙）');
          return;
        }
        applyEngineMove(result);
      })
      .catch(function (err) {
        thinking = false;
        if (token !== turnToken) return;
        setStatus('引擎出错：' + err.message);
      });
  }

  function engineLabelForStatus() {
    return engineForPlay() === Difficulty.PIKAFISH ? 'Pikafish ' : '内置引擎 ';
  }

  function applyEngineMove(result) {
    var sq = game.ucciToSq(result.move);
    if (!sq) {
      setStatus('引擎返回了无法解析的着法：' + result.move);
      return;
    }
    // 用本地规则再校验一遍引擎给的着法。两边不一致时宁可停下并明确报错，
    // 也不能默默走一步非法棋 —— 更不能什么都不做把界面卡死。
    if (!game.isLegalMoveFull(sq.from, sq.to)) {
      setStatus('引擎返回的着法 ' + result.move + ' 未通过本地规则校验，已停止本步。');
      return;
    }

    var applied = game.applyUciMove(result.move);
    if (!applied) {
      setStatus('着法落子失败：' + result.move);
      return;
    }

    lastMove = { from: sq.from, to: sq.to };
    board.render(game, lastMove);
    appendMoveToRow('AI', applied, result.info);

    if (gameMode === 'eve') {
      // 机机对战：留一点停顿，否则棋子在视觉上一瞬间就下完了
      setStatus('AI 落子完成，准备下一步…');
      var nextToken = turnToken;
      window.setTimeout(function () {
        if (nextToken !== turnToken) return;   // 这期间已经悔棋/重开了
        beginTurn();
      }, 350);
    } else {
      beginTurn();
    }
  }

  // -------------------------------------------------------------------------
  // 人类落子
  // -------------------------------------------------------------------------

  function handleHumanMove(from, to) {
    if (thinking) {
      setStatus('引擎正在思考，请稍候。');
      board.clearSelection();
      return;
    }
    if (gameMode === 'eve') return;

    var piece = game.board[from];
    if (!piece) return;
    if (gameMode === 'pve' && piece.color !== playerSide) return;
    if (piece.color !== game.turn) {
      setStatus('现在轮到' + sideLabel(game.turn) + '走子。');
      board.clearSelection();
      return;
    }

    if (!game.isLegalMoveFull(from, to)) {
      setStatus('该着法不符合当前局面规则，请重新落子。');
      board.clearSelection();
      return;
    }

    var uci = game.sqToUcci(from, to);
    var applied = game.applyUciMove(uci);
    if (!applied) {
      board.clearSelection();
      return;
    }

    lastMove = { from: from, to: to };
    board.render(game, lastMove);
    appendMoveToRow('玩家', applied, null);

    if (summaryEl) summaryEl.classList.add('hide');
    beginTurn();
  }

  // -------------------------------------------------------------------------
  // 悔棋
  // -------------------------------------------------------------------------

  function handleUndo() {
    if (thinking) {
      setStatus('引擎正在思考，暂时不能悔棋。');
      return;
    }
    if (game.history.length === 0) {
      setStatus('还没有可悔的着法。');
      return;
    }

    // 人机对战要连撤两步（AI 的一步 + 自己的一步），否则撤完还是轮到 AI，
    // 它会立刻把同一着再走一遍，看起来像"悔棋没生效"。
    var steps = (gameMode === 'pve' && game.history.length >= 2) ? 2 : 1;

    for (var i = 0; i < steps; i++) game.undo();

    turnToken += 1;
    thinking = false;
    board.selectedSq = null;
    if (summaryEl) summaryEl.classList.add('hide');

    var last = game.history[game.history.length - 1];
    lastMove = last ? { from: last.from, to: last.to } : null;
    board.render(game, lastMove);
    rebuildStatsTable();
    setStatus('已悔棋。轮到' + sideLabel(game.turn) + '走子。');
  }

  // -------------------------------------------------------------------------
  // 终局
  // -------------------------------------------------------------------------

  function finishGame(text) {
    thinking = false;
    setStatus('对局结束：' + text);
    if (summaryTextEl) summaryTextEl.innerText = text;
    if (summaryEl) summaryEl.classList.remove('hide');
  }

  // -------------------------------------------------------------------------
  // 侧栏统计（全部取自引擎真实输出，不伪造数据）
  // -------------------------------------------------------------------------

  function appendMoveToRow(source, moveStr, info) {
    if (!statsBodyEl) return;
    var emptyRow = document.getElementById('ai-stats-empty');
    if (emptyRow) emptyRow.remove();

    var tr = document.createElement('tr');
    var mover = opponent(game.turn);   // 落子后 turn 已经翻转，所以刚走的是对方
    var sourceClass = (source === 'AI') ? 'source-ai' : 'source-human';

    var nodesStr = '-';
    var npsStr = '-';
    var timeStr = '-';
    var scoreStr = '-';
    var scoreClass = 'score-neutral';

    if (info) {
      if (typeof info.nodes === 'number') nodesStr = info.nodes.toLocaleString();
      if (typeof info.nps === 'number') npsStr = info.nps.toLocaleString();
      if (typeof info.time === 'number') timeStr = info.time + 'ms';
      if (typeof info.score === 'number') {
        scoreStr = (info.score > 0 ? '+' : '') + info.score;
        if (info.score > 0) scoreClass = 'score-positive';
        else if (info.score < 0) scoreClass = 'score-negative';
      }
      // 采样后走的不是引擎首选着法时标注出来，让"难度的弱"是可见的
      if (info.sampled) scoreStr += '（次优）';
    }

    tr.innerHTML = `
      <td>${game.history.length}</td>
      <td>${sideLabel(mover).charAt(0)}</td>
      <td class="${sourceClass}">${source}</td>
      <td>${moveStr}</td>
      <td>${nodesStr}</td>
      <td>${npsStr}</td>
      <td>${timeStr}</td>
      <td class="${scoreClass}">${scoreStr}</td>
    `;

    statsBodyEl.appendChild(tr);
    var wrap = document.getElementById('ai-table-wrap');
    if (wrap) wrap.scrollTop = wrap.scrollHeight;
  }

  function clearStatsTable() {
    if (!statsBodyEl) return;
    statsBodyEl.innerHTML =
      '<tr id="ai-stats-empty"><td colspan="8">等待对局开始。开局后显示实时搜索统计</td></tr>';
  }

  /**
   * 悔棋后重建统计表。历史上没有留下每一步的搜索统计，
   * 所以这里只还原序号与着法，其余列留 '-' —— 宁可不显示，也不编造。
   */
  function rebuildStatsTable() {
    if (!statsBodyEl) return;
    if (game.history.length === 0) {
      clearStatsTable();
      return;
    }

    statsBodyEl.innerHTML = '';
    for (var i = 0; i < game.history.length; i++) {
      var entry = game.history[i];
      var tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${sideLabel(entry.piece.color).charAt(0)}</td>
        <td>-</td>
        <td>-</td>
        <td>${entry.ucci}</td>
        <td>-</td>
        <td>-</td>
        <td>-</td>
      `;
      statsBodyEl.appendChild(tr);
    }
  }

  // -------------------------------------------------------------------------
  // 按钮绑定
  // -------------------------------------------------------------------------

  var undoBtn = document.getElementById('undo-btn');
  if (undoBtn) undoBtn.addEventListener('click', handleUndo);

  var undoBtn2 = document.getElementById('undobtn');
  if (undoBtn2) undoBtn2.addEventListener('click', handleUndo);

  function restart() {
    if (summaryEl) summaryEl.classList.add('hide');
    window.onGameStart(gameMode, playerSide, currentLevel);
  }

  var restartBtn = document.getElementById('restart-btn');
  if (restartBtn) restartBtn.addEventListener('click', restart);

  var restartBtn2 = document.getElementById('restartbtn');
  if (restartBtn2) restartBtn2.addEventListener('click', restart);
});
