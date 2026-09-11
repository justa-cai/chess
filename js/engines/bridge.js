/**
 * bridge.js - 引擎可插拔层（主线程门面）
 *
 * 把"两个完全不同的引擎"（纯 JS 的 wukong、WASM 的 Pikafish）收敛成同一套
 * 异步接口，app.js 只跟这一层打交道，不需要知道底下是 Worker、WASM 还是
 * 纯 JS 搜索，也不需要知道 Pikafish 要额外下载 49MB 权重。
 *
 * 关键机制：
 *
 * · **seq 请求-响应配对**。每次 search 分配一个自增 seq，只认带匹配 seq 的回包。
 *   这一条同时解决两件事：
 *     1) 引擎来不及处理时会有过期回包，靠 seq 丢弃；
 *     2) pikafish-engine.js 自带的处理器会**主动**往主线程发不带 seq 的
 *        `BEST_MOVE` / `INFO`（它在收到 bestmove 时抢先发一次），这里只认
 *        带 seq 的，天然把它过滤掉，否则档位采样会被绕过。
 *
 * · **懒加载 + 切换即销毁**。wukong 只有 57KB，页面加载时就预热，切档瞬时；
 *   Pikafish 带 49MB 权重，只在用户真的选到高档位时才创建 Worker。
 *
 * · **超时兜底**。加载 90s、搜索按档位 movetime 推算。超时不静默 ——
 *   一律 reject 并带上可读原因，让上层能提示用户而不是卡住。
 *
 * @license GPL-3.0
 */

(function (global) {
  'use strict';

  var ENGINES = {
    wukong: {
      id: 'wukong',
      label: '内置 JS 引擎',
      workerUrl: 'js/engines/wukong/wukong.worker.js',
      weightBytes: 0
    },
    pikafish: {
      id: 'pikafish',
      label: 'Pikafish (WASM + NNUE)',
      workerUrl: 'js/worker/pikafish.worker.js',
      weightBytes: 51585654
    }
  };

  var LOAD_TIMEOUT_MS = 90000;

  // 搜索超时。产物没有 asyncify，`go` 一旦开始就无法中断，所以这个值必须
  // 明显大于引擎自己的时间上限（档位的 maxMs），只作为"引擎真的没反应"的
  // 兜底 —— 设得太紧会把首次搜索（线程池冷启动、置换表为空）误判成失败。
  var SEARCH_TIMEOUT_SLACK_MS = 30000;
  var MIN_SEARCH_TIMEOUT_MS = 45000;

  // 每个引擎的运行时状态
  var runtimes = {};

  // 事件回调
  var handlers = {
    onProgress: null,  // ({engine, loaded, total, ratio})
    onStage: null,     // ({engine, stage})  stage: 'weights' | 'engine' | 'handshake' | 'ready'
    onError: null      // ({engine, message})
  };

  var seqCounter = 0;

  function nextSeq() {
    seqCounter += 1;
    return seqCounter;
  }

  function runtimeOf(engineId) {
    if (!runtimes[engineId]) {
      runtimes[engineId] = {
        id: engineId,
        worker: null,
        ready: false,
        loadPromise: null,
        loadResolve: null,
        loadReject: null,
        pending: {}      // seq -> {resolve, reject, timer}
      };
    }
    return runtimes[engineId];
  }

  /** 订阅进度/阶段/错误事件 */
  function configure(options) {
    options = options || {};
    if (options.onProgress) handlers.onProgress = options.onProgress;
    if (options.onStage) handlers.onStage = options.onStage;
    if (options.onError) handlers.onError = options.onError;
  }

  function emit(name, payload) {
    if (handlers[name]) handlers[name](payload);
  }

  // ---------------------------------------------------------------------------
  // Worker 生命周期
  // ---------------------------------------------------------------------------

  function spawn(engineId) {
    var runtime = runtimeOf(engineId);
    var meta = ENGINES[engineId];
    if (!meta) throw new Error('未知引擎: ' + engineId);

    var worker = new Worker(meta.workerUrl);
    runtime.worker = worker;
    runtime.ready = false;
    runtime.loadPromise = new Promise(function (resolve, reject) {
      runtime.loadResolve = resolve;
      runtime.loadReject = reject;
    });

    worker.onmessage = function (event) {
      handleMessage(engineId, event.data);
    };

    worker.onerror = function (event) {
      var message = (event && event.message) ? event.message : '引擎 Worker 出错';
      failLoad(engineId, message);
    };

    // 兜底：长时间没就绪就判失败，避免界面无限等待
    runtime.loadTimer = setTimeout(function () {
      failLoad(engineId, '引擎加载超时（' + Math.round(LOAD_TIMEOUT_MS / 1000) + ' 秒未就绪）');
    }, LOAD_TIMEOUT_MS);

    worker.postMessage({ type: 'INIT_ENGINE' });
    return runtime;
  }

  function failLoad(engineId, message) {
    var runtime = runtimeOf(engineId);
    if (runtime.ready) return;
    if (runtime.loadTimer) {
      clearTimeout(runtime.loadTimer);
      runtime.loadTimer = null;
    }
    emit('onError', { engine: engineId, message: message });
    if (runtime.loadReject) {
      var reject = runtime.loadReject;
      runtime.loadResolve = null;
      runtime.loadReject = null;
      reject(new Error(message));
    }
  }

  function handleMessage(engineId, data) {
    data = data || {};
    var runtime = runtimeOf(engineId);

    if (data.type === 'LOAD_PROGRESS') {
      emit('onProgress', {
        engine: engineId,
        loaded: data.loaded,
        total: data.total,
        ratio: data.total ? (data.loaded / data.total) : 0
      });
      return;
    }

    if (data.type === 'LOAD_STAGE') {
      emit('onStage', { engine: engineId, stage: data.stage });
      return;
    }

    if (data.type === 'READY') {
      if (runtime.ready) return;   // 内建层与包装层各会发一条 READY，只处理第一条
      runtime.ready = true;
      if (runtime.loadTimer) {
        clearTimeout(runtime.loadTimer);
        runtime.loadTimer = null;
      }
      emit('onStage', { engine: engineId, stage: 'ready' });
      if (runtime.loadResolve) {
        var resolve = runtime.loadResolve;
        runtime.loadResolve = null;
        runtime.loadReject = null;
        resolve(runtime);
      }
      return;
    }

    if (data.type === 'ERROR') {
      var message = data.message || '引擎报错';
      if (!runtime.ready) {
        failLoad(engineId, message);
      } else {
        emit('onError', { engine: engineId, message: message });
      }
      // 出错也要把正在等这个回包的请求放掉，否则上层会一直挂着
      settleAll(runtime, new Error(message));
      return;
    }

    if (data.type === 'BEST_MOVE') {
      // 只认带 seq 的（内建层发的那条不带 seq，必须丢弃，见文件头）
      if (data.seq === undefined || data.seq === null) return;
      var best = take(runtime, data.seq);
      if (!best) return;
      best.resolve({
        move: data.move,
        info: data.info || null,
        legalMoves: (typeof data.legalMoves === 'number') ? data.legalMoves : null,
        engine: engineId
      });
      return;
    }

    if (data.type === 'VALIDATION_RESULT') {
      if (data.seq === undefined || data.seq === null) return;
      var check = take(runtime, data.seq);
      if (!check) return;
      check.resolve(!!data.legal);
      return;
    }

    if (data.type === 'POSITION_STATUS_RESULT') {
      if (data.seq === undefined || data.seq === null) return;
      var status = take(runtime, data.seq);
      if (!status) return;
      status.resolve((typeof data.count === 'number') ? data.count : null);
      return;
    }

    // 内建层不带 seq 的 INFO 等杂音一律忽略
  }

  function take(runtime, seq) {
    var entry = runtime.pending[seq];
    if (!entry) return null;
    delete runtime.pending[seq];
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  }

  function settleAll(runtime, error) {
    var seqs = Object.keys(runtime.pending);
    for (var i = 0; i < seqs.length; i++) {
      var entry = runtime.pending[seqs[i]];
      delete runtime.pending[seqs[i]];
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /** 确保引擎已加载并返回 {worker, ready} 的 Promise */
  function load(engineId) {
    var runtime = runtimeOf(engineId);
    if (runtime.ready) return Promise.resolve(runtime);
    if (!runtime.worker) spawn(engineId);
    return runtime.loadPromise;
  }

  /** 销毁引擎 Worker，释放它的内存（Pikafish 的 Hash + 权重相当可观） */
  function unload(engineId) {
    var runtime = runtimeOf(engineId);
    if (!runtime.worker) return;
    settleAll(runtime, new Error('引擎已被卸载'));
    runtime.worker.terminate();
    runtime.worker = null;
    runtime.ready = false;
    runtime.loadPromise = null;
    runtime.loadResolve = null;
    runtime.loadReject = null;
    if (runtime.loadTimer) {
      clearTimeout(runtime.loadTimer);
      runtime.loadTimer = null;
    }
  }

  function isReady(engineId) {
    return runtimeOf(engineId).ready;
  }

  function isLoaded(engineId) {
    return !!runtimeOf(engineId).worker;
  }

  // ---------------------------------------------------------------------------
  // 请求
  // ---------------------------------------------------------------------------

  function request(engineId, payload, timeoutMs) {
    var runtime = runtimeOf(engineId);
    var seq = nextSeq();
    return new Promise(function (resolve, reject) {
      runtime.pending[seq] = {
        resolve: resolve,
        reject: reject,
        timer: setTimeout(function () {
          delete runtime.pending[seq];
          reject(new Error('引擎响应超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
        }, timeoutMs)
      };
      payload.seq = seq;
      payload.type = payload.type || 'SEARCH_LEVEL';
      runtime.worker.postMessage(payload);
    });
  }

  /**
   * 让引擎在给定局面下按档位出一个着法。
   * @param {string} engineId
   * @param {{fen:string, startFen?:string, level:number, moves?:string[]}} options
   *        startFen + moves 用来让引擎重建完整的重复局面历史（只给当前 FEN
   *        的话引擎没有记忆，会主动走进重复循环）
   * @returns {Promise<{move:string, info:object|null, legalMoves:number|null}>}
   */
  function search(engineId, options) {
    var level = global.Difficulty.getLevel(options.level);
    var timeoutMs = Math.max(MIN_SEARCH_TIMEOUT_MS, (level.maxMs || 0) + SEARCH_TIMEOUT_SLACK_MS);

    return load(engineId).then(function () {
      return request(engineId, {
        type: 'SEARCH_LEVEL',
        fen: options.fen,
        startFen: options.startFen || null,
        moves: options.moves || [],
        level: level.level
      }, timeoutMs);
    });
  }

  /**
   * 查一个局面下"行棋方"还有多少合法着法。返回 0 即该方被将死或困毙。
   * 象棋里无着可走即判负，所以这个数就是终局判定的依据 ——
   * xiangqi.js 里并没有 in_checkmate/in_stalemate 这类判定，全靠它。
   * @returns {Promise<number|null>} null 表示引擎没能算出来
   */
  function status(engineId, fen) {
    return load(engineId).then(function () {
      return request(engineId, {
        type: 'POSITION_STATUS',
        fen: fen
      }, MIN_SEARCH_TIMEOUT_MS);
    });
  }

  // ---------------------------------------------------------------------------
  // 能力探测
  // ---------------------------------------------------------------------------

  /**
   * Pikafish 走的是 pthread + SharedArrayBuffer 多线程路径，必须在
   * 跨源隔离（crossOriginIsolated）环境下才能构造共享内存。静态托管时这个
   * 环境由 coi-serviceworker.js 提供，而它首次注册后会强制 reload 一次 ——
   * 在那之前选高档位必然失败。这里给出可查询的状态，让 UI 能提前禁用并解释原因。
   */
  function supportsThreadedWasm() {
    return typeof SharedArrayBuffer === 'function' && global.crossOriginIsolated === true;
  }

  var EngineBridge = {
    ENGINES: ENGINES,
    configure: configure,
    load: load,
    unload: unload,
    isReady: isReady,
    isLoaded: isLoaded,
    search: search,
    status: status,
    supportsThreadedWasm: supportsThreadedWasm
  };

  global.EngineBridge = EngineBridge;

})(typeof window !== 'undefined' ? window : this);
