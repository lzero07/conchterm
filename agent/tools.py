"""Agent 模式的工具定义（由 LangChain bind_tools 消费）。

实际执行发生在 Rust/前端侧（需要用户逐条确认），
这里的函数体不会在本地运行，仅用于生成工具 schema。
"""

from langchain_core.tools import tool


@tool
def run_command(command: str) -> str:
    """在用户的 SSH 会话中执行一条 shell 命令并返回输出（执行前需要用户确认）。"""
    return ""
