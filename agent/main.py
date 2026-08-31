"""ConchTerm 智能体 sidecar：stdin/stdout 上的 JSON Lines 协议。

请求（Rust -> Python，一行一个 JSON）：
  {"type": "chat", "id": "r1", "provider": {...}, "messages": [...]}

响应（Python -> Rust）：
  {"type": "ready"}                                   进程就绪
  {"type": "delta", "id": "r1", "content": "..."}     流式增量
  {"type": "done",  "id": "r1"}                       回合结束
  {"type": "error", "id": "r1", "message": "..."}     本回合失败
  {"type": "tool_call", "id": "r1", "callId": "c1",
   "tool": "run_command", "args": {"command": "..."}} 请求宿主执行命令

请求还可以是（Agent 模式的工具执行结果回传）：
  {"type": "tool_result", "callId": "c1", "approved": true, "output": "..."}
"""

import json
import sys
import threading

from providers import build_model, to_messages

_WRITE_LOCK = threading.Lock()
_WORKER_THREADS = []

# Agent 模式的安全护栏
MAX_TOOL_ROUNDS = 8
TOOL_OUTPUT_LIMIT = 8000
TOOL_WAIT_TIMEOUT = 120

# call_id -> {"event": Event, "result": dict | None}
_TOOL_RESULTS = {}
_TOOL_LOCK = threading.Lock()


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


def wait_for_tool_result(call_id: str) -> dict:
    """挂起工作线程，等待宿主回传该次工具调用的结果。"""
    event = threading.Event()
    with _TOOL_LOCK:
        _TOOL_RESULTS[call_id] = {"event": event, "result": None}
    ok = event.wait(TOOL_WAIT_TIMEOUT)
    with _TOOL_LOCK:
        entry = _TOOL_RESULTS.pop(call_id, None)
    if not ok or not entry or entry["result"] is None:
        return {"approved": False, "output": "", "timeout": True}
    return entry["result"]


def handle_tool_result(req: dict) -> None:
    """stdin 主循环收到工具结果：唤醒对应的工作线程。"""
    with _TOOL_LOCK:
        entry = _TOOL_RESULTS.get(req.get("callId", ""))
    if entry is not None:
        entry["result"] = {
            "approved": bool(req.get("approved")),
            "output": req.get("output", ""),
        }
        entry["event"].set()


def handle_agent(req: dict) -> None:
    """Agent 模式：bind_tools 循环，模型决定执行什么，宿主确认后执行并回填。"""
    req_id = req.get("id", "")
    try:
        from langchain_core.messages import ToolMessage

        from tools import run_command

        model = build_model(req.get("provider", {})).bind_tools([run_command])
        messages = to_messages(req.get("messages", []))

        for _ in range(MAX_TOOL_ROUNDS):
            response = model.invoke(messages)
            tool_calls = getattr(response, "tool_calls", None) or []
            text = extract_text(response.content)
            if text:
                emit({"type": "delta", "id": req_id, "content": text})
            if not tool_calls:
                emit({"type": "done", "id": req_id})
                return

            messages.append(response)
            for tc in tool_calls:
                call_id = tc.get("id") or f"call{id(tc):x}"
                emit(
                    {
                        "type": "tool_call",
                        "id": req_id,
                        "callId": call_id,
                        "tool": tc.get("name", ""),
                        "args": tc.get("args") or {},
                    }
                )
                result = wait_for_tool_result(call_id)
                if result.get("timeout"):
                    emit(
                        {
                            "type": "error",
                            "id": req_id,
                            "message": f"工具确认超时（{TOOL_WAIT_TIMEOUT} 秒无响应）",
                        }
                    )
                    return
                if result["approved"]:
                    content = result["output"][:TOOL_OUTPUT_LIMIT]
                else:
                    content = (
                        "用户拒绝执行该命令。请勿再次尝试相同或相似的命令，"
                        "改为向用户解释或询问下一步意愿。"
                    )
                messages.append(ToolMessage(content=content, tool_call_id=call_id))

        emit(
            {
                "type": "error",
                "id": req_id,
                "message": f"已达到最大工具调用轮数（{MAX_TOOL_ROUNDS}）",
            }
        )
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
            mode = req.get("mode", "chat")
            target = handle_agent if mode == "agent" else handle_chat
            worker = threading.Thread(target=target, args=(req,))
            worker.start()
            _WORKER_THREADS.append(worker)
        elif req.get("type") == "tool_result":
            handle_tool_result(req)

    # stdin EOF：等待在途请求完成后再退出（上限 60s 防止卡死）
    for t in _WORKER_THREADS:
        t.join(timeout=60)


if __name__ == "__main__":
    main()
