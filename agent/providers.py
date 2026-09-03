"""根据 Provider 配置构建 LangChain 聊天模型。

LangChain 相关依赖采用函数内懒加载：
缺依赖时 sidecar 进程可以正常启动，错误在请求级以事件形式回传。
"""


def build_model(provider: dict):
    """按协议创建对应的 LangChain 聊天模型实例。"""
    protocol = provider.get("protocol", "openai")
    model = provider["model"]
    api_key = provider.get("api_key") or "EMPTY"
    base_url = provider.get("base_url") or None

    if protocol == "anthropic":
        from langchain_anthropic import ChatAnthropic

        kwargs = {
            "model": model,
            "api_key": api_key,
            "max_tokens": 4096,
            "streaming": True,
        }
        if base_url:
            kwargs["base_url"] = base_url
        return ChatAnthropic(**kwargs)

    # openai 协议：OpenAI 官方及所有兼容服务（DeepSeek/Ollama/OpenRouter 等）
    from langchain_openai import ChatOpenAI

    kwargs = {
        "model": model,
        "api_key": api_key,
        "streaming": True,
        # 请求在最后一个流式 chunk 中返回 usage（监控中心统计 token 用量）
        "stream_usage": True,
    }
    if base_url:
        kwargs["base_url"] = base_url
    return ChatOpenAI(**kwargs)


def to_messages(items: list) -> list:
    """把 JSON 消息数组转成 LangChain 消息对象。"""
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    messages = []
    for item in items:
        role = item.get("role", "user")
        content = item.get("content", "")
        if role == "system":
            messages.append(SystemMessage(content=content))
        elif role == "assistant":
            messages.append(AIMessage(content=content))
        else:
            messages.append(HumanMessage(content=content))
    return messages
