/**
 * xiangqi.js - 中国象棋局面与 FEN 状态容器
 * 合法性、将死与困毙由 Pikafish 统一裁定。
 *
 * @author Jeff Hlywa (jhlywa) & lengyanyu258
 * @license BSD 2-Clause License
 * @see https://github.com/lengyanyu258/xiangqi.js
 *
 * Copyright (c) 2017-2023 Jeff Hlywa & lengyanyu258
 * All rights reserved.
 */

(function (global) {
  'use strict';

  // 棋子类型与阵营定义
  const RED = 'r';
  const BLACK = 'b';

  // 初始开局标准 FEN 码
  const DEFAULT_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

  function Xiangqi(fen) {
    this.board = new Array(90).fill(null); // 9列 x 10行
    this.turn = RED; // 'w' 或 'r' 表示红方先手，'b' 表示黑方
    this.history = [];
    this.load(fen || DEFAULT_FEN);
  }

  // 加载与解析 FEN 码
  Xiangqi.prototype.load = function (fen) {
    const tokens = fen.trim().split(/\s+/);
    const position = tokens[0];
    this.turn = (tokens[1] === 'b') ? BLACK : RED;
    // 记住起始局面。引擎需要 `position fen <起始> moves <全部着法>` 才能
    // 重建完整的重复局面历史 —— 只发当前 FEN 的话引擎是无记忆的，
    // 会主动走进重复循环。
    this.startFen = fen.trim();

    this.board.fill(null);
    let row = 0;
    let col = 0;

    for (let i = 0; i < position.length; i++) {
      const c = position.charAt(i);
      if (c === '/') {
        row++;
        col = 0;
      } else if (c >= '1' && c <= '9') {
        col += parseInt(c, 10);
      } else {
        const color = (c === c.toUpperCase()) ? RED : BLACK;
        const type = c.toLowerCase();
        const sq = row * 9 + col;
        this.board[sq] = { type: type, color: color };
        col++;
      }
    }
  };

  // 生成当前局面 FEN 码
  Xiangqi.prototype.fen = function () {
    let empty = 0;
    let fen = '';

    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const piece = this.board[r * 9 + c];
        if (piece === null) {
          empty++;
        } else {
          if (empty > 0) {
            fen += empty;
            empty = 0;
          }
          const symbol = (piece.color === RED) ? piece.type.toUpperCase() : piece.type.toLowerCase();
          fen += symbol;
        }
      }
      if (empty > 0) {
        fen += empty;
        empty = 0;
      }
      if (r < 9) {
        fen += '/';
      }
    }

    const activeColor = (this.turn === RED) ? 'w' : 'b';
    return fen + ' ' + activeColor + ' - - 0 1';
  };

  // 坐标转 UCCI 着法 (例如 row 9, col 1 到 row 7, col 2 -> b2c4 / h2e2)
  Xiangqi.prototype.sqToUcci = function (fromSq, toSq) {
    const fromCol = String.fromCharCode('a'.charCodeAt(0) + (fromSq % 9));
    const fromRow = 9 - Math.floor(fromSq / 9);
    const toCol = String.fromCharCode('a'.charCodeAt(0) + (toSq % 9));
    const toRow = 9 - Math.floor(toSq / 9);
    return fromCol + fromRow + toCol + toRow;
  };

  // UCCI 着法转换为数组索引 (例如 "h2e2" -> {from: 79, to: 76})
  Xiangqi.prototype.ucciToSq = function (ucci) {
    if (!/^[a-i][0-9][a-i][0-9]$/.test(ucci || '')) return null;
    const fromCol = ucci.charCodeAt(0) - 'a'.charCodeAt(0);
    const fromRow = 9 - parseInt(ucci.charAt(1), 10);
    const toCol = ucci.charCodeAt(2) - 'a'.charCodeAt(0);
    const toRow = 9 - parseInt(ucci.charAt(3), 10);

    return {
      from: fromRow * 9 + fromCol,
      to: toRow * 9 + toCol
    };
  };

  // 校验具体棋子走法规则（别马腿、塞象眼、九宫格界限）
  Xiangqi.prototype.isLegalMove = function (fromSq, toSq) {
    const piece = this.board[fromSq];
    if (!piece) return false;
    
    const target = this.board[toSq];
    if (target && target.color === piece.color) return false;

    const fromRow = Math.floor(fromSq / 9);
    const fromCol = fromSq % 9;
    const toRow = Math.floor(toSq / 9);
    const toCol = toSq % 9;
    const dr = Math.abs(toRow - fromRow);
    const dc = Math.abs(toCol - fromCol);

    switch (piece.type) {
      case 'k': // 帅 / 将：只能在九宫格内走直线一格
        if (toCol < 3 || toCol > 5) return false;
        if (piece.color === RED && (toRow < 7 || toRow > 9)) return false;
        if (piece.color === BLACK && (toRow < 0 || toRow > 2)) return false;
        return (dr + dc === 1);

      case 'a': // 仕 / 士：只能在九宫格内斜走一格
        if (toCol < 3 || toCol > 5) return false;
        if (piece.color === RED && (toRow < 7 || toRow > 9)) return false;
        if (piece.color === BLACK && (toRow < 0 || toRow > 2)) return false;
        return (dr === 1 && dc === 1);

      case 'b': // 相 / 象：走田字，不能过河，不能被塞象眼
        if (dr !== 2 || dc !== 2) return false;
        if (piece.color === RED && toRow < 5) return false; // 红相不能过河
        if (piece.color === BLACK && toRow > 4) return false; // 黑象不能过河
        const eyeSq = ((fromRow + toRow) / 2) * 9 + ((fromCol + toCol) / 2);
        if (this.board[eyeSq] !== null) return false; // 塞象眼
        return true;

      case 'n': // 马：走日字，不能被别马腿
        if (!((dr === 1 && dc === 2) || (dr === 2 && dc === 1))) return false;
        let legSq;
        if (dr === 2) {
          legSq = ((fromRow + toRow) / 2) * 9 + fromCol;
        } else {
          legSq = fromRow * 9 + ((fromCol + toCol) / 2);
        }
        if (this.board[legSq] !== null) return false; // 别马腿
        return true;

      case 'r': // 车：走直线，中间不能有棋子
      case 'c': // 炮：走直线，移动不吃子中间 0 子，吃子中间隔 1 子
        if (fromRow !== toRow && fromCol !== toCol) return false;
        let obstacles = 0;
        if (fromRow === toRow) {
          const minCol = Math.min(fromCol, toCol);
          const maxCol = Math.max(fromCol, toCol);
          for (let c = minCol + 1; c < maxCol; c++) {
            if (this.board[fromRow * 9 + c] !== null) obstacles++;
          }
        } else {
          const minRow = Math.min(fromRow, toRow);
          const maxRow = Math.max(fromRow, toRow);
          for (let r = minRow + 1; r < maxRow; r++) {
            if (this.board[r * 9 + fromCol] !== null) obstacles++;
          }
        }

        if (piece.type === 'r') {
          return obstacles === 0;
        } else { // 炮
          if (target === null) return obstacles === 0;
          else return obstacles === 1;
        }

      case 'p': // 兵 / 卒：只能走一格，不能倒退，未过河不能横走
        if (dr + dc !== 1) return false;
        if (piece.color === RED) {
          if (toRow > fromRow) return false; // 红兵不能向下倒退
          if (fromRow >= 5 && dc !== 0) return false; // 未过河不能横走
        } else {
          if (toRow < fromRow) return false; // 黑卒不能向上倒退
          if (fromRow <= 4 && dc !== 0) return false; // 未过河不能横走
        }
        return true;

      default:
        return false;
    }
  };

  // ---------------------------------------------------------------------------
  // 完整合法性：在基础走法之上再排除「白脸将」与「自杀着」
  //
  // 注意这两条都不是"某个棋子的走法非法"，而是"走完之后局面非法"，
  // 所以只能在 switch 之外用"试走 → 检查 → 回滚"的方式判断，
  // 不能塞进上面的 isLegalMove switch 分支里。
  //
  // 这里只用于棋盘落子提示点的准确性；真正的合法性仍由引擎
  // (pikafish_validate_move / wukong 的 generateLegalMoves) 兜底。
  // ---------------------------------------------------------------------------

  // 找到某方将帅所在格；不存在时返回 -1
  Xiangqi.prototype.findKing = function (color) {
    for (let i = 0; i < 90; i++) {
      const p = this.board[i];
      if (p && p.type === 'k' && p.color === color) return i;
    }
    return -1;
  };

  // 判断 sq 是否被 color 方的任意棋子攻击。
  // 直接复用 isLegalMove 的几何判定 —— 它已经正确处理了别马腿、塞象眼、
  // 炮翻山、兵卒过河等全部走法限制，没必要再写一遍。
  Xiangqi.prototype.isSquareAttacked = function (sq, color) {
    for (let i = 0; i < 90; i++) {
      const p = this.board[i];
      if (!p || p.color !== color) continue;
      if (this.isLegalMove(i, sq)) return true;
    }
    return false;
  };

  // 双方将帅是否照面（同列且中间无子）—— 即「白脸将」
  Xiangqi.prototype.kingsFacing = function () {
    const redKing = this.findKing(RED);
    const blackKing = this.findKing(BLACK);
    if (redKing < 0 || blackKing < 0) return false;

    const redCol = redKing % 9;
    if (redCol !== blackKing % 9) return false;

    const minRow = Math.min(Math.floor(redKing / 9), Math.floor(blackKing / 9));
    const maxRow = Math.max(Math.floor(redKing / 9), Math.floor(blackKing / 9));
    for (let r = minRow + 1; r < maxRow; r++) {
      if (this.board[r * 9 + redCol] !== null) return false;
    }
    return true;
  };

  // 该方是否正被将军
  Xiangqi.prototype.inCheck = function (color) {
    const king = this.findKing(color);
    if (king < 0) return true; // 将帅已不在盘上，按被将死处理
    return this.isSquareAttacked(king, color === RED ? BLACK : RED);
  };

  // 完整合法性：试走一步，检查己方是否被将军或双方将帅照面，然后回滚
  Xiangqi.prototype.isLegalMoveFull = function (fromSq, toSq) {
    if (!this.isLegalMove(fromSq, toSq)) return false;

    const mover = this.board[fromSq];
    if (!mover) return false;

    const captured = this.board[toSq];
    this.board[toSq] = mover;
    this.board[fromSq] = null;

    const ok = !this.inCheck(mover.color) && !this.kingsFacing();

    this.board[fromSq] = mover;
    this.board[toSq] = captured;
    return ok;
  };

  // 仅执行已经由 Pikafish 验证或生成的着法，不承担规则裁定。
  Xiangqi.prototype.applyMove = function (fromSq, toSq) {
    const piece = this.board[fromSq];
    if (!piece || piece.color !== this.turn) return null;

    const target = this.board[toSq];
    if (target && target.color === piece.color) return null;

    // 执行落子
    this.board[toSq] = piece;
    this.board[fromSq] = null;

    const ucciMove = this.sqToUcci(fromSq, toSq);
    this.history.push({ from: fromSq, to: toSq, piece: piece, captured: target, ucci: ucciMove });
    this.turn = (this.turn === RED) ? BLACK : RED;

    return ucciMove;
  };

  Xiangqi.prototype.applyUciMove = function (ucciMove) {
    const squares = this.ucciToSq(ucciMove);
    if (!squares) return null;
    return this.applyMove(squares.from, squares.to);
  };

  // 撤回一步 (悔棋)
  Xiangqi.prototype.undo = function () {
    if (this.history.length === 0) return null;
    const lastMove = this.history.pop();
    this.board[lastMove.from] = lastMove.piece;
    this.board[lastMove.to] = lastMove.captured;
    this.turn = (this.turn === RED) ? BLACK : RED;
    return lastMove;
  };

  global.Xiangqi = Xiangqi;
})(typeof window !== 'undefined' ? window : this);
