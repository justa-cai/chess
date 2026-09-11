#!/usr/bin/env python3
"""
Chinese-Chess-AI 本地静态 Web 开发服务器

功能：
- 默认绑定 6324 端口（可通过 --port 自定义）。
- 支持多进程 / 多线程高并发加载 HTML、CSS、JS 与 .wasm 二进制资源。
- 自动补齐 WASM 的 MIME 类型与 Cross-Origin 隔离响应头 (COOP/COEP)，确保 WASM 和 Worker 正常运行。

使用方法：
    python3 server.py
"""

from __future__ import annotations

import argparse
import contextlib
import functools
import mimetypes
import os
import socket
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 在 POSIX 系统上尝试导入 ForkingHTTPServer 以支持多进程加载，非 POSIX 回退至 ThreadingHTTPServer
try:
    from http.server import ForkingHTTPServer
    HAS_FORKING = True
except ImportError:
    HAS_FORKING = False

PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 6324


class MultiProcessStaticHandler(SimpleHTTPRequestHandler):
    """静态文件处理器：补充 WASM MIME 类型并添加 Cross-Origin 隔离响应头"""

    # 引擎的大体积二进制资源。NNUE 权重文件名内含官方网络 SHA256 前缀
    # (pikafish-9e20a9a44415.nnue)，内容变更必然伴随文件名变更，
    # 因此可以安全地长缓存 —— 否则每次刷新都要重下 49MB。
    # 只对这两类扩展名生效，JS/CSS/HTML 仍走 no-store，保证改完刷新即见。
    IMMUTABLE_EXTENSIONS = (".nnue", ".wasm")

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        path = self.path.split("?", 1)[0]
        if path.endswith(self.IMMUTABLE_EXTENSIONS):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()


def port_is_free(host: str, port: int) -> bool:
    """检查指定端口是否处于可绑定闲置状态"""
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
        return True


def find_first_available_port(host: str, start_port: int = DEFAULT_PORT, max_attempts: int = 100) -> int:
    """从 start_port 开始递增扫描，找到第一个可绑定的空闲端口"""
    for port in range(start_port, start_port + max_attempts):
        if port_is_free(host, port):
            return port
    raise RuntimeError(f"在 {start_port} 至 {start_port + max_attempts - 1} 范围内未找到可用端口")


def parse_args() -> argparse.Namespace:
    """解析命令行参数"""
    parser = argparse.ArgumentParser(description="Chinese-Chess-AI 开发服务器")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"监听地址，默认 {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"指定起始端口，默认 {DEFAULT_PORT}")
    parser.add_argument("--mode", choices=["process", "thread"], default="process", help="并发模式：process (多进程) 或 thread (多线程)")
    return parser.parse_args()


def main() -> None:
    """启动并发静态服务器"""
    mimetypes.add_type("application/wasm", ".wasm")
    mimetypes.add_type("text/javascript", ".js")

    args = parse_args()

    target_port = args.port
    if not port_is_free(args.host, target_port):
        print(f"提示: 端口 {target_port} 被占用，开始从 {target_port} 依次扫描可用端口...", flush=True)
        try:
            target_port = find_first_available_port(args.host, target_port)
        except RuntimeError as err:
            print(f"错误: {err}", file=sys.stderr)
            sys.exit(1)

    handler = functools.partial(MultiProcessStaticHandler, directory=os.fspath(PROJECT_ROOT))

    if args.mode == "process" and HAS_FORKING:
        server_class = ForkingHTTPServer
        mode_desc = "多进程并发 (Forking)"
    else:
        server_class = ThreadingHTTPServer
        mode_desc = "多线程并发 (Threading)"

    server = server_class((args.host, target_port), handler)

    url = f"http://{args.host}:{target_port}/"
    print(f"Chinese-Chess-AI 本地服务已启动 ({mode_desc})", flush=True)
    print(f"服务地址: {url}", flush=True)
    print("按下 Ctrl+C 可停止服务。", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务器已成功停止。", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
