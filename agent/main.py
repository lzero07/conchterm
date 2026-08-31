"""ConchTerm 智能体 sidecar：stdin/stdout 上的 JSON Lines 协议。

请求（Rust -> Python，一行一个 JSON）：
  {"type": "chat", "id": "r1", "provider": {...}, "messages": [...]}

响应（Python -> Rust）：
  {"type": "ready"}                                   进程就绪
  {"type": "delta", "id": "r1", "content": "..."}     流式增量
  {"type": "done",  "id": "r1"}                       回合结束
  {"type": "error", "id": "r1", "message": "..."}     本回合失败
"""

import json
import sys
import threading

from providers import build_model, to_messages

_WRITE_LOCK = threading.Lock()
_WORKER_THREADS = []


def emit(event: dict) -> None:
    """线程安全地写一行 JSON 到 stdout。"""
    with _WRITE_LOCK:
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def extract_text(content) -> str:
    """兼容字符串与 content block 列表两种返回格式。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return ""


def handle_chat(req: dict) -> None:
    """处理一次聊天请求：流式生成并逐段回写。"""
    req_id = req.get("id", "")
    try:
        model = build_model(req.get("provider", {}))
        messages = to_messages(req.get("messages", []))
        for chunk in model.stream(messages):
            text = extract_text(chunk.content)
            if text:
                emit({"type": "delta", "id": req_id, "content": text})
        emit({"type": "done", "id": req_id})
    except Exception as exc:  # 网络/鉴权/缺依赖等异常统一转成事件回传
        message = str(exc) or exc.__class__.__name__
        if "No module named" in message:
            message += "（请先安装依赖: pip install -r agent/requirements.txt）"
        emit({"type": "error", "id": req_id, "message": message})


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    emit({"type": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        if req.get("type") == "chat":
            # 每个请求独立线程，网络等待不阻塞后续请求的接收；
            # 非 daemon 保证 stdin 关闭后（如应用退出）在途请求能跑完
            worker = threading.Thread(target=handle_chat, args=(req,))
            worker.start()
            _WORKER_THREADS.append(worker)

    # stdin EOF：等待在途请求完成后再退出（上限 60s 防止卡死）
    for t in _WORKER_THREADS:
        t.join(timeout=60)


if __name__ == "__main__":
    main()
