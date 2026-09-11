/**
 * xiangqiboard.js - 中国象棋 DOM 棋盘渲染与菜单交互器
 *
 * @author Chris Oakman & lengyanyu258
 * @license MIT License
 * @see https://github.com/lengyanyu258/xiangqiboardjs
 *
 * Copyright (c) 2017-2023 Chris Oakman & lengyanyu258
 * Released under the MIT license
 */

(function (global) {
  'use strict';

  // 棋子汉字映射表
  const PIECE_NAMES = {
    'k': { 'r': '帅', 'b': '将' },
    'a': { 'r': '仕', 'b': '士' },
    'b': { 'r': '相', 'b': '象' },
    'n': { 'r': '马', 'b': '馬' },
    'r': { 'r': '车', 'b': '車' },
    'c': { 'r': '炮', 'b': '砲' },
    'p': { 'r': '兵', 'b': '卒' }
  };

  function XiangqiBoard(containerId, options) {
    this.container = document.getElementById(containerId);
    this.options = options || {};
    this.selectedSq = null;
    this.onMoveCallback = this.options.onMove || null;
    
    this.initDOM();
    this.bindMenuEvents();
  }

  // 初始化 DOM 结构
  XiangqiBoard.prototype.initDOM = function () {
    if (!this.container) return;
    this.container.innerHTML = '';
    
    const boardGrid = document.createElement('div');
    boardGrid.className = 'xiangqi-board-grid';
    boardGrid.style.cssText = 'position:relative; width:100%; height:100%; display:grid; grid-template-columns: repeat(9, 1fr); grid-template-rows: repeat(10, 1fr);';

    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const sqIndex = r * 9 + c;
        const cell = document.createElement('div');
        cell.className = 'xiangqi-cell';
        cell.dataset.sq = sqIndex;
        cell.style.cssText = 'position:relative; display:flex; align-items:center; justify-content:center; cursor:pointer; user-select:none; border:1px solid rgba(141,91,40,0.2);';
        
        cell.addEventListener('click', this.onCellClick.bind(this, sqIndex));
        boardGrid.appendChild(cell);
      }
    }
    
    this.container.appendChild(boardGrid);

    // 渲染经典中国象棋“楚 河 漢 界”河界水墨大字
    const riverLayer = document.createElement('div');
    riverLayer.className = 'xiangqi-river-layer';
    riverLayer.style.cssText = `
      position: absolute;
      top: 40%;
      left: 0;
      width: 100%;
      height: 20%;
      display: flex;
      align-items: center;
      justify-content: space-around;
      pointer-events: none;
      z-index: 2;
      font-family: "Kaiti SC", "STKaiti", "KaiTi", serif;
      font-size: 26px;
      font-weight: 900;
      color: rgba(100, 60, 20, 0.45);
      letter-spacing: 12px;
      user-select: none;
    `;

    const riverLeft = document.createElement('div');
    riverLeft.innerText = '楚 河';
    const riverRight = document.createElement('div');
    riverRight.innerText = '漢 界';

    riverLayer.appendChild(riverLeft);
    riverLayer.appendChild(riverRight);
    this.container.appendChild(riverLayer);
  };

  // 根据 Xiangqi 实例数据更新渲染棋盘
  XiangqiBoard.prototype.render = function (game, lastMove) {
    if (!game || !this.container) return;
    // 记住最近一次渲染的局面对象。onCellClick 用它而不是全局
    // window.gameInstance —— 否则"悔棋后换了 game 对象但棋盘还在读旧的"
    // 这类错位会非常难查。
    this.game = game;
    if (lastMove !== undefined) this.lastMove = lastMove;

    const selectedPiece = (this.selectedSq !== null) ? game.board[this.selectedSq] : null;
    const isCurrentTurn = selectedPiece && (selectedPiece.color === game.turn);

    const cells = this.container.querySelectorAll('.xiangqi-cell');
    cells.forEach((cell, idx) => {
      cell.innerHTML = '';
      cell.classList.remove('selected', 'highlight', 'last-move');

      if (this.selectedSq === idx) {
        cell.classList.add('selected');
        if (isCurrentTurn) {
          cell.style.backgroundColor = 'rgba(39, 174, 96, 0.35)';
          cell.style.boxShadow = 'inset 0 0 8px #27ae60';
        } else {
          cell.style.backgroundColor = 'rgba(231, 76, 60, 0.35)';
          cell.style.boxShadow = 'inset 0 0 8px #e74c3c';
        }
      } else if (this.lastMove && (this.lastMove.from === idx || this.lastMove.to === idx)) {
        cell.classList.add('last-move');
        cell.style.backgroundColor = 'rgba(230, 126, 34, 0.38)';
        cell.style.boxShadow = 'inset 0 0 10px #e67e22';
      } else {
        cell.style.backgroundColor = 'transparent';
        cell.style.boxShadow = 'none';
      }

      // 如果当前有选中的起子，高亮合法落子目标格 (己方绿色，敌方红色)。
      // 用 isLegalMoveFull 而非 isLegalMove —— 后者只判基本走法，
      // 会把"白脸将"和"自杀着"也画成可落子点，误导玩家。
      if (this.selectedSq !== null && game.isLegalMoveFull) {
        if (game.isLegalMoveFull(this.selectedSq, idx)) {
          const hintDot = document.createElement('div');
          hintDot.className = 'move-hint-dot';
          const dotColor = isCurrentTurn ? 'rgba(39, 174, 96, 0.8)' : 'rgba(231, 76, 60, 0.85)';
          const dotGlow = isCurrentTurn ? 'rgba(39, 174, 96, 0.9)' : 'rgba(231, 76, 60, 0.9)';
          hintDot.style.cssText = `width: 14px; height: 14px; border-radius: 50%; background: ${dotColor}; box-shadow: 0 0 6px ${dotGlow}; position: absolute; z-index: 5;`;
          cell.appendChild(hintDot);
        }
      }

      const piece = game.board[idx];
      if (piece) {
        const pieceEl = document.createElement('div');
        pieceEl.className = 'xiangqi-piece ' + (piece.color === 'r' ? 'piece-red' : 'piece-black');
        const name = PIECE_NAMES[piece.type] ? PIECE_NAMES[piece.type][piece.color] : piece.type;
        pieceEl.innerText = name;
        pieceEl.style.cssText = `
          width: 44px;
          height: 44px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          font-weight: 700;
          box-shadow: 0 3px 6px rgba(0,0,0,0.3);
          background: ${piece.color === 'r' ? '#fff0f0' : '#2b2b2b'};
          color: ${piece.color === 'r' ? '#c0392b' : '#ffffff'};
          border: 2px solid ${piece.color === 'r' ? '#c0392b' : '#111111'};
        `;
        cell.appendChild(pieceEl);
      }
    });
  };

  // 点击落子交互处理
  XiangqiBoard.prototype.onCellClick = function (sqIndex) {
    const game = this.game;
    if (!game) return;

    if (this.selectedSq === null) {
      if (game.board[sqIndex]) {
        this.selectedSq = sqIndex;
        this.render(game);
      }
    } else {
      if (this.selectedSq === sqIndex) {
        this.selectedSq = null;
        this.render(game);
      } else {
        const from = this.selectedSq;
        const to = sqIndex;
        this.selectedSq = null;

        if (this.onMoveCallback) {
          this.onMoveCallback(from, to);
        }
      }
    }
  };

  // 清空选中态并重绘。悔棋、重开、换档之后都要调，
  // 否则会残留"选中格 + 落子提示点"的幻影。
  XiangqiBoard.prototype.clearSelection = function () {
    this.selectedSq = null;
    if (this.game) this.render(this.game);
  };

  // 绑定多级开局遮罩菜单事件 (完全对应 ui_example 交互)
  XiangqiBoard.prototype.bindMenuEvents = function () {
    const menuMain = document.getElementById('menu');
    const menuMode = document.getElementById('menu-mode');
    const menuModePve = document.getElementById('menu-mode-pve');
    const menuLevel = document.getElementById('menu-level');
    const boardOptions = document.getElementById('board-options');

    const startBtn = document.getElementById('startbtn');
    const returnToMain = document.getElementById('return-to-main');
    const returnToMode = document.getElementById('return-to-mode');
    const returnFromLevel = document.getElementById('return-from-level');
    const pveBtn = document.getElementById('pvebtn');
    const pvpBtn = document.getElementById('pvpbtn');
    const eveBtn = document.getElementById('evebtn');
    const pfBtn = document.getElementById('pfbtn');
    const efBtn = document.getElementById('efbtn');

    if (startBtn) {
      startBtn.addEventListener('click', function () {
        menuMain.classList.add('hide');
        menuMode.classList.remove('hide');
      });
    }

    const helpBtn = document.getElementById('helpbtn');
    if (helpBtn) {
      helpBtn.addEventListener('click', function () {
        alert(
          "【中国象棋对弈规则与系统说明】\n\n" +
          "1. 对局模式：\n" +
          "   - 本机双人：两位玩家在同一设备轮流落子对决。\n" +
          "   - 人机对战：玩家与 WebAssembly 引擎对弈（可选执红/执黑）。\n" +
          "   - 机机对决：自动开启 AI 对 AI 算法自我连贯演练。\n\n" +
          "2. 行棋规则：\n" +
          "   - 马走日（受别马腿阻断限制）。\n" +
          "   - 相/象走田（不可过河，受塞象眼限制）。\n" +
          "   - 车走直线无障碍；炮移动无障碍，吃子需隔一棋子。\n" +
          "   - 兵/卒未过河只能直走一格，过河后可横走，不可倒退。\n" +
          "   - 仕/士与帅/将限定在九宫格范围内移动。\n\n" +
          "3. 交互提示：\n" +
          "   - 选中己方棋子显示【绿色】落子点，选中敌方显示【警示红色】（只看不可动）。\n" +
          "   - 落子后起点与终点显示【橙金发光框】着法轨迹。"
        );
      });
    }

    if (returnToMain) {
      returnToMain.addEventListener('click', function () {
        menuMode.classList.add('hide');
        menuMain.classList.remove('hide');
      });
    }

    if (pveBtn) {
      pveBtn.addEventListener('click', function () {
        menuMode.classList.add('hide');
        menuModePve.classList.remove('hide');
      });
    }

    if (returnToMode) {
      returnToMode.addEventListener('click', function () {
        menuModePve.classList.add('hide');
        menuMode.classList.remove('hide');
      });
    }

    // 开始对局：隐藏遮罩层
    function startGameMode(mode, side, level) {
      if (boardOptions) boardOptions.classList.add('hide');
      if (window.onGameStart) {
        window.onGameStart(mode, side, level);
      }
    }

    // 进入难度选择；levelBackTo 记住该退回哪一层菜单
    let levelBackTo = menuMode;
    // 人机对战里玩家是否执红先走，由先手菜单的两个按钮决定
    let playerFirst = true;

    function showLevelMenu(backTo) {
      levelBackTo = backTo;
      if (menuMain) menuMain.classList.add('hide');
      if (menuMode) menuMode.classList.add('hide');
      if (menuModePve) menuModePve.classList.add('hide');
      if (menuLevel) menuLevel.classList.remove('hide');
    }

    if (pfBtn) pfBtn.addEventListener('click', function () { playerFirst = true; showLevelMenu(menuModePve); });
    if (efBtn) efBtn.addEventListener('click', function () { playerFirst = false; showLevelMenu(menuModePve); });

    if (pvpBtn) pvpBtn.addEventListener('click', function () { startGameMode('pvp', 'r'); });
    if (eveBtn) eveBtn.addEventListener('click', function () { showLevelMenu(menuMode); });

    if (returnFromLevel) {
      returnFromLevel.addEventListener('click', function () {
        if (menuLevel) menuLevel.classList.add('hide');
        if (levelBackTo === menuModePve) {
          if (menuModePve) menuModePve.classList.remove('hide');
        } else {
          if (menuMode) menuMode.classList.remove('hide');
        }
      });
    }

    // 六个难度按钮。人机先手在进入难度菜单前就已确定，这里从菜单可见性反推：
    // 从先手菜单进来的，说明是 pve；从模式菜单进来的，是 eve。
    document.querySelectorAll('.level-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const level = parseInt(btn.dataset.level, 10);
        if (levelBackTo === menuModePve) {
          startGameMode('pve', playerFirst ? 'r' : 'b', level);
        } else {
          startGameMode('eve', 'r', level);
        }
      });
    });
  };

  global.XiangqiBoard = XiangqiBoard;
})(typeof window !== 'undefined' ? window : this);
