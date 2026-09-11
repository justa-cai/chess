/**
 * pikafish.worker.js - 高档位 Pikafish(WASM) 引擎的 Worker 包装层
 *
 * 设计要点（每一条都对应一个具体的坑，改动前请先读完）：
 *
 * 1. **不修改 `pikafish-engine.js`**。那是 79KB / 全文件 2 行的 Emscripten
 *    构建产物，仓库里没有 `third-party/pikafish/src`（被 .gitignore 排除），
 *    无法重新生成，手改风险高。这里改为在外面包一层：
 *    classic worker 的顶层 `var Module` 会成为全局属性，所以包装层可以直接
 *    用 `Module.postMessage(cmd)` 发 UCI 命令、用 `Module.addMessageListener(fn)`
 *    拿到引擎的每一行原始输出、用 `Module.ccall(...)` 调自定义导出函数。
 *
 * 2. **pthread 池守卫（漏了就会 N 倍下载权重）**。产物里
 *    `PThread.allocateUnusedWorker()` 执行的是
 *    `new Worker(_scriptName, {name:"em-pthread"})`，而 `_scriptName` 就是
 *    **本文件**的 URL —— 也就是说本文件会被当成线程池里每个 worker 的入口
 *    再执行一遍。如果不加守卫，每个池 worker 都会跑一遍权重预取，
 *    16 核机器就是 16 份 49MB。pre-js 自己用
 *    `if(globalThis.name!=="em-pthread")` 做了同样的守卫，这里必须照做。
 *
 * 3. **消息类型刻意与内建层错开**。pikafish-engine.js 里有一个自带的
 *    `handleIncomingMessage`，它只认 `INIT` / `SEARCH` / `VALIDATE` / `STATUS` /
 *    `STOP` 五种类型（无 else 分支，未知类型静默忽略）。本包装层因此一律使用
 *    `INIT_ENGINE` / `SEARCH_LEVEL` / `STOP_SEARCH` / `UCI_CMD`
 *    这些**不同的名字**，让内建处理器永远不匹配，从而完全避免"同一件事被处理
 *    两遍"。这比 monkey-patch `self.postMessage` 干净得多。
 *
 *    反过来，内建层发出的 `READY` / `BEST_MOVE` / `INFO` 都是**不带 seq** 的，
 *    而本包装层发出的一律带 seq。bridge 只认带 seq 的，据此过滤掉内建层的
 *    杂音 —— 这一点很关键：内建层在收到 `bestmove` 时会抢先把自己的 BEST_MOVE
 *    post 出去，如果不做 seq 过滤，档位采样等于白做。
 *
 * 4. **NNUE 的下载与缓存**。49MB 权重是全部体验成本的大头，所以这段做得很细：
 *
 *    a) 用**流式读取**拿真实下载进度。pre-js 内部那次 fetch 走的是
 *       `response.arrayBuffer()`，不流式、观测不到，必须由包装层自己先读一遍。
 *    b) 用 `self.fetch` 垫片 + Cache Storage 做**只下载一次**的保证。这一点在
 *       GitHub Pages 上是必需的：Pages 对所有资源只发 `Cache-Control: max-age=600`，
 *       光靠 HTTP 缓存的话，用户隔十分钟回来就要重下 49MB。
 *       垫片只拦 `.nnue`，其它 URL 原样透传给真正的 fetch（尤其不能拦
 *       `.wasm` —— 流式编译需要真实的 `application/wasm` 响应）。
 *    c) Cache Storage 在某些浏览器/隐私模式下不可用或超配额，一律**降级**到
 *       直接网络请求，绝不能因此白屏。
 *
 * 5. **消息监听必须在脚本顶层同步注册**。预取要花好几秒，如果等预取完再注册，
 *    这期间 bridge 发来的消息就会丢失。所以先注册、先入队，引擎起来后再回放。
 *
 * 6. **本文件必须与 pikafish-engine.js 放在同一目录**。pre-js 用
 *    `new URL("../../nnue/pikafish-9e20a9a44415.nnue", self.location.href)` 定位权重，
 *    而 `self.location.href` 是**本 Worker 脚本**的 URL。挪到别的目录深度会导致
 *    权重 404。
 *
 * @license GPL-3.0
 */

'use strict';

(function () {
  // -------------------------------------------------------------------------
  // pthread 池 worker 分支：只装载 Emscripten 运行时，不碰权重、不注册桥接。
  // 这些 worker 由 PThread.allocateUnusedWorker() 以本文件为入口创建，
  // ENVIRONMENT_IS_PTHREAD 为真，胶水的 run() 会直接 return，
  // 因此不会触发 pre-js 的 postRun，也就不会去取权重。见文件头第 2 条。
  // -------------------------------------------------------------------------
  if (self.name === 'em-pthread') {
    importScripts('pikafish-engine.js');
    return;
  }

  importScripts('../difficulty.js');

  var NNUE_RELATIVE_PATH = '../../nnue/pikafish-9e20a9a44415.nnue';
  // 缓存名带版本号：换网络文件时改这个字符串即可让旧副本自然失效
  var NNUE_CACHE_NAME = 'pikafish-nnue-v1';
  // 原始 fetch。下面的垫片会替换 self.fetch，必须先把引用留住
  var realFetch = self.fetch.bind(self);

  var engineBooted = false;
  var queuedMessages = [];
  var initSent = false;

  // 当前一次搜索的候选着法，按 multipv 序号归并（深层结果会覆盖浅层的同名项）
  var candidates = new Map();
  var activeSearchSeq = null;
  // 当前搜索使用的采样温度，由 SEARCH_LEVEL 按档位设置
  var activeTemperature = 0;
  // 当前局面的合法着法数。为 0 即终局（被将死或困毙），
  // 象棋里无着可走即判负。这个值由 pikafish_legal_move_count 同步导出计算。
  var activeLegalMoveCount = null;

  // 本次会话里权重字节的 Promise（见 loadNnueBytes 的注释）
  var nnueBytesPromise = null;

  // -------------------------------------------------------------------------
  // 原始引擎输出解析
  // -------------------------------------------------------------------------

  /**
   * 解析一行 UCI `info`。
   *
   * 之所以自己解析而不用 pre-js 里的 `parseUciInfoLine`：那个函数只认
   * depth/nodes/nps/time/score，**不解析 `multipv` 和 `pv`** —— 而这两样正是
   * 难度采样所必需的。自己解析也让 Emscripten 产物保持原封不动。
   */
  function parseInfoLine(line) {
    if (line.indexOf('info ') !== 0) return null;

    var tokens = line.split(/\s+/);
    var out = { multipv: 1, move: null, score: null, depth: null, nodes: null, nps: null, time: null };

    for (var i = 1; i < tokens.length; i++) {
      switch (tokens[i]) {
        case 'multipv': out.multipv = parseInt(tokens[++i], 10); break;
        case 'depth':   out.depth   = parseInt(tokens[++i], 10); break;
        case 'nodes':   out.nodes   = parseInt(tokens[++i], 10); break;
        case 'nps':     out.nps     = parseInt(tokens[++i], 10); break;
        case 'time':    out.time    = parseInt(tokens[++i], 10); break;
        case 'score':
          // 形如 `score cp 25` 或 `score mate -3`；后面还可能跟 lowerbound/upperbound
          var kind = tokens[i + 1];
          if (kind === 'cp' || kind === 'mate') {
            out.score = Difficulty.scoreToCp(kind, parseInt(tokens[i + 2], 10));
            i += 2;
          } else {
            i += 1;
          }
          break;
        case 'pv':
          // pv 的第一个着法就是这条候选线的落子
          out.move = tokens[i + 1] || null;
          i = tokens.length; // 后面不用再看了
          break;
        default:
          break;
      }
    }
    return out;
  }

  /** 把一行 info 归并进当前候选表 */
  function collectCandidate(info) {
    if (!info || !info.move || info.score === null) return;
    var index = (info.multipv > 0) ? info.multipv : 1;
    candidates.set(index, {
      move: info.move,
      score: info.score,
      depth: info.depth,
      nodes: info.nodes,
      nps: info.nps,
      time: info.time
    });
  }

  /** 用自定义导出同步计算合法着法数；失败时返回 null 而不是编一个数 */
  function countLegalMoves(fen) {
    try {
      return Number(Module.ccall('pikafish_legal_move_count', 'bigint', ['string'], [fen]));
    } catch (err) {
      return null;
    }
  }

  /** 引擎一行原始输出的分发入口 */
  function handleRawLine(rawLine) {
    var line = String(rawLine || '').trim();
    if (!line) return;

    if (line.indexOf('info ') === 0) {
      collectCandidate(parseInfoLine(line));
      return;
    }

    if (line.indexOf('readyok') === 0) {
      // 内建层也会在收到 readyok 时对外发一条 READY（不带 seq）。
      // 这里再发一条带 engine 标识的；bridge 对 READY 不做 seq 校验，
      // 谁先到都能正确 resolve 加载 Promise。
      self.postMessage({ type: 'READY', engine: 'pikafish' });
      return;
    }

    if (line.indexOf('bestmove') === 0) {
      finishSearch(line.split(/\s+/)[1] || '(none)');
    }
  }

  /** 收齐候选着法后按档位采样，产出最终着法 */
  function finishSearch(engineBestMove) {
    var seq = activeSearchSeq;
    activeSearchSeq = null;

    var list = [];
    candidates.forEach(function (entry) { list.push(entry); });
    candidates.clear();

    var chosen = null;
    if (list.length > 0 && engineBestMove !== '(none)') {
      chosen = Difficulty.pickByTemperature(list, activeTemperature);
    }

    // 没有候选（例如搜索极短、来不及产出 info）时退回引擎自己的 bestmove
    if (!chosen) {
      self.postMessage({
        type: 'BEST_MOVE',
        seq: seq,
        move: engineBestMove,
        legalMoves: activeLegalMoveCount,
        info: null
      });
      return;
    }

    self.postMessage({
      type: 'BEST_MOVE',
      seq: seq,
      move: chosen.move,
      legalMoves: activeLegalMoveCount,
      info: {
        depth: chosen.depth,
        nodes: chosen.nodes,
        nps: chosen.nps,
        time: chosen.time,
        score: chosen.score,
        // 采样后的着法与引擎首选不同时标注出来，侧栏据此提示"非最优着法"
        sampled: chosen.move !== engineBestMove,
        engineBest: engineBestMove
      }
    });
  }

  // -------------------------------------------------------------------------
  // 来自 bridge 的消息
  // -------------------------------------------------------------------------

  function sendUci(command) {
    Module.postMessage(command);
  }

  function handleSearchLevel(data) {
    var level = Difficulty.getLevel(data.level);
    var multipv = level.multipv || 1;

    candidates.clear();
    activeSearchSeq = data.seq;
    activeTemperature = level.temperature || 0;
    activeLegalMoveCount = countLegalMoves(data.fen);

    // 终局：无合法着法。没必要再让引擎搜了，直接回 (none)。
    if (activeLegalMoveCount === 0) {
      finishSearch('(none)');
      return;
    }

    // 优先用「起始局面 + 全部着法」重建，引擎才能看到重复局面并避免长将循环。
    // 注意不能写成 `position fen <当前局面> moves <全部着法>` —— 那会把着法
    // 在已经走完的局面之上再走一遍，等于把非法着法喂给引擎。
    var positionCmd;
    if (data.moves && data.moves.length && data.startFen) {
      positionCmd = 'position fen ' + data.startFen + ' moves ' + data.moves.join(' ');
    } else {
      positionCmd = 'position fen ' + data.fen;
    }

    sendUci('setoption name MultiPV value ' + multipv);
    sendUci(positionCmd);
    // maxMs 是安全网：产物没有 asyncify，`go` 同步阻塞且无法中断，
    // 万一某个局面搜得过久，用户既取消不了也悔不了棋。正常情况根本不会触发。
    if (level.depth > 0) {
      var cap = level.maxMs ? (' movetime ' + level.maxMs) : '';
      sendUci('go depth ' + level.depth + cap);
    } else {
      sendUci('go movetime ' + (level.movetimeMs || 3000));
    }
  }

  function dispatchToEngine(data) {
    if (!data || !data.type) return;

    switch (data.type) {
      case 'INIT_ENGINE':
        if (!initSent) {
          initSent = true;
          // 后续的 setoption EvalFile/Threads/Hash 与 isready 由
          // pikafish-engine.js 自带的 handleEngineLine 在收到 uciok 后完成
          sendUci('uci');
        }
        break;

      case 'SEARCH_LEVEL':
        handleSearchLevel(data);
        break;

      case 'POSITION_STATUS':
        // 只用来做终局判定（合法着法数为 0 即被将死或困毙）。
        // 走自定义导出同步计算，比让引擎 "go" 一次便宜得多。
        self.postMessage({
          type: 'POSITION_STATUS_RESULT',
          seq: data.seq,
          count: countLegalMoves(data.fen)
        });
        break;

      case 'STOP_SEARCH':
        // 注意：产物没有 asyncify，`go` 在上游是同步阻塞的，
        // 这条 stop 只能排在当前搜索结束之后才被消费，无法真正打断。
        // 真正的中断手段是把 movetime 封顶（见 difficulty.js 的档位表）。
        sendUci('stop');
        break;

      case 'UCI_CMD':
        sendUci(String(data.cmd || ''));
        break;

      default:
        break;
    }
  }

  // 顶层同步注册 —— 见文件头第 5 条。引擎就绪前先入队，避免丢消息。
  self.addEventListener('message', function (event) {
    var data = event.data;
    if (!engineBooted) {
      queuedMessages.push(data);
      return;
    }
    dispatchToEngine(data);
  });

  // -------------------------------------------------------------------------
  // 启动：预取权重（带进度）→ importScripts → 回放队列
  // -------------------------------------------------------------------------

  function nnueUrl() {
    try {
      return new URL(NNUE_RELATIVE_PATH, self.location.href).href;
    } catch (err) {
      return NNUE_RELATIVE_PATH;
    }
  }

  function nnueResponse(bytes) {
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.byteLength)
      }
    });
  }

  function readCachedBytes(url) {
    if (typeof caches === 'undefined') return Promise.resolve(null);
    return caches.open(NNUE_CACHE_NAME)
      .then(function (cache) { return cache.match(url); })
      .then(function (hit) { return hit ? hit.arrayBuffer() : null; })
      .catch(function () { return null; });
  }

  function storeBytes(url, bytes) {
    if (typeof caches === 'undefined') return;
    caches.open(NNUE_CACHE_NAME).then(function (cache) {
      return cache.put(url, nnueResponse(bytes));
    }).catch(function (err) {
      // 存不下不影响本次启动（可能超配额或被隐私模式限制），
      // 但要让开发者看得见 —— 否则"一刷新就重下 49MB"会变成一个找不到原因的怪现象
      console.warn('[Pikafish] 权重写入 Cache Storage 失败，下次仍需重新下载：', err);
    });
  }

  /** 走网络流式下载，边读边报进度，最后拼成一个连续的 ArrayBuffer */
  function downloadBytes(url) {
    return realFetch(url, { credentials: 'same-origin' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);

      var total = parseInt(response.headers.get('Content-Length'), 10) || 0;
      if (!response.body || typeof response.body.getReader !== 'function') {
        // 不支持流式读取：没有进度，但功能不受影响
        return response.arrayBuffer();
      }

      var reader = response.body.getReader();
      var chunks = [];
      var loaded = 0;

      var pump = function () {
        return reader.read().then(function (chunk) {
          if (chunk.done) return null;
          chunks.push(chunk.value);
          loaded += chunk.value.length;
          self.postMessage({ type: 'LOAD_PROGRESS', engine: 'pikafish', loaded: loaded, total: total });
          return pump();
        });
      };

      return pump().then(function () {
        var bytes = new Uint8Array(loaded);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
          bytes.set(chunks[i], offset);
          offset += chunks[i].length;
        }
        return bytes.buffer;
      });
    });
  }

  /**
   * 取权重的唯一入口。同一会话内只解析一次（nnueBytesPromise 去重），
   * 跨会话则靠 Cache Storage。
   *
   * 为什么要额外在内存里留一份：如果只依赖 Cache Storage，pre-js 内部那次
   * `fetch(nnueUrl)` 可能在 `cache.put` 落盘之前就发起，于是 49MB 被下载两遍。
   * 内存里的这一份能保证本次会话绝对只下一次。
   */
  function loadNnueBytes(url) {
    if (nnueBytesPromise) return nnueBytesPromise;

    self.postMessage({ type: 'LOAD_STAGE', engine: 'pikafish', stage: 'weights' });
    nnueBytesPromise = readCachedBytes(url).then(function (cached) {
      if (cached) {
        self.postMessage({ type: 'LOAD_STAGE', engine: 'pikafish', stage: 'cached' });
        return cached;
      }
      return downloadBytes(url).then(function (bytes) {
        storeBytes(url, bytes);
        return bytes;
      });
    });
    return nnueBytesPromise;
  }

  // 拦下 pre-js 内部那次取权重的 fetch，让它复用上面那份字节。
  // 只匹配 .nnue，其余（尤其 .wasm）必须原样透传 —— wasm 流式编译
  // 需要真实的响应头，合成响应会让 instantiateStreaming 失败。
  self.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : ((input && input.url) || '');
    if (!/\.nnue(\?|$)/.test(url)) return realFetch(input, init);
    return loadNnueBytes(url).then(nnueResponse);
  };

  // -------------------------------------------------------------------------
  // 低内存设备的内存封顶
  // -------------------------------------------------------------------------

  // pre-js 里硬编码了 `setoption name Hash value 256`，也就是 256MB 置换表。
  // 桌面端无所谓，但手机上 256MB 置换表 + 49MB 权重常驻同一个 WASM 堆里，
  // 很容易被系统直接杀掉（不是报错，是整个页面没了）。
  //
  // 不能去改那 79KB 的 Emscripten 产物（见文件头第 1 条），好在有别的口子：
  // pre-js 内部发命令的 `send()` 就是 `Module.postMessage(cmd)` 的薄封装，
  // 它在**调用时**才去查 `Module.postMessage`。而握手里的这些 setoption 是在
  // 收到 `uciok` 之后才发出的，一定晚于 bootEngine —— 所以在这里把这层换掉，
  // 就能在命令入队之前改写，不存在"改晚了"的竞态。
  //
  // 只改写这一条**完全匹配**的命令，其余一律原样透传（匹配不上就等于没做），
  // 因此不会破坏握手。取不到 deviceMemory 时按桌面处理，保持原样。
  var HARDCODED_HASH_CMD = 'setoption name Hash value 256';
  var LOW_MEMORY_HASH_MB = 64;
  var DESKTOP_HASH_MB = 256;

  function applyMemoryCap() {
    if (typeof Module === 'undefined' || typeof Module.postMessage !== 'function') return;

    var gb = (self.navigator && self.navigator.deviceMemory) || 0;
    if (!(gb > 0 && gb <= 4)) return;   // 桌面 / 取不到 → 保持 256MB

    var realPostMessage = Module.postMessage;
    Module.postMessage = function (command) {
      var text = String(command);
      if (text === HARDCODED_HASH_CMD) {
        text = 'setoption name Hash value ' + LOW_MEMORY_HASH_MB;
        console.warn('[Pikafish] 低内存设备（deviceMemory=' + gb + 'GB）：置换表由 256MB 下调至 ' + LOW_MEMORY_HASH_MB + 'MB');
      }
      return realPostMessage.call(Module, text);
    };
  }

  function bootEngine() {
    self.postMessage({ type: 'LOAD_STAGE', engine: 'pikafish', stage: 'engine' });
    importScripts('pikafish-engine.js');
    applyMemoryCap();
    Module.addMessageListener(handleRawLine);
    engineBooted = true;
    self.postMessage({ type: 'LOAD_STAGE', engine: 'pikafish', stage: 'handshake' });

    var pending = queuedMessages;
    queuedMessages = [];
    for (var i = 0; i < pending.length; i++) {
      dispatchToEngine(pending[i]);
    }
  }

  loadNnueBytes(nnueUrl())
    .then(function () {
      bootEngine();
      // 字节已经进了 Emscripten 的 MEMFS，worker 里这一份可以放掉了，
      // 免得 49MB 常驻（移动端内存本来就紧张）
      nnueBytesPromise = null;
    })
    .catch(function (err) {
      self.postMessage({
        type: 'ERROR',
        message: 'NNUE 权重加载失败：' + ((err && err.message) ? err.message : String(err))
      });
      // 取权重失败也要把引擎拉起来：让它自己去取一遍，从而报出真实的失败原因
      try {
        bootEngine();
      } catch (bootErr) {
        self.postMessage({
          type: 'ERROR',
          message: '引擎脚本加载失败：' + ((bootErr && bootErr.message) ? bootErr.message : String(bootErr))
        });
      }
    });
})();
