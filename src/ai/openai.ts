import type { ChatMessage, ChatResult } from "./types";

export interface ChatOnceOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
} //重新定义interface,使得AI层不依赖配置层

export class ChatError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, options?: { status?: number; body?: string }) {
    super(message);
    this.name = "ChatError";
    this.status = options?.status;
    this.body = options?.body;
  }
}

interface OpenAIResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
} //字段全写成可选,因为外部JSON不可信,服务器可能少字段或者返回错误结构

export async function chatOnce(options: ChatOnceOptions): Promise<ChatResult> {
  const url = `${options.baseUrl}/chat/completions`;

  //1.发请求
  let response: Response;

  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        messages: options.messages,
        stream: false,
      }),
      signal: options.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ChatError(`Network error while calling ${url}:${message}`);
  }

  //2.检查HTTP状态
  if (!response.ok) {
    const body = await response.text();
    const detail = body.slice(0, 500).trim();

    throw new ChatError(
      `Chat request failed: ${response.status} ${response.statusText} ${detail ? `\n${detail}` : ""}`,
      { status: response.status, body: detail },
    );
  }

  //3.解析JSON
  let data: OpenAIResponse;

  try {
    data = (await response.json()) as OpenAIResponse; //as是强制类型转换
  } catch {
    throw new ChatError("Chat response was not valid JSON.");
  }

  //4.取文本
  const text = data.choices?.[0]?.message?.content;

  if (typeof text !== "string") {
    throw new ChatError("Chat response did not contain text");
  }

  return {
    text,
    model: data.model ?? options.model,
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
  };
}
