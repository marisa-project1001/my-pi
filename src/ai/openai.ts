import type { ChatMessage, ChatResult, ChatStreamEvent } from "./types";

export interface ChatOptions {
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


export async function chatOnce(options: ChatOptions): Promise<ChatResult> {
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
      if (options.signal?.aborted) {
        throw new ChatError("Request aborted");
      }
      
      
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

interface OpenAIStreamResponse {
    choices?: Array<{
        delta?: {
            content?: string | null;
        };
    }>;
}//流式响应类型

function readSseData(rawEvent: string): string | null {
    const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
        
    if (dataLines.length === 0) return null;
    
    return dataLines.join("\n");
}//从时间块中取data

function parseDelta(data: string): string | undefined {
    let parsed: unknown;
    
    try {
        parsed = JSON.parse(data);
    } catch {
        throw new ChatError(`Invalid SSE JSON: ${data.slice(0,200)}`);
    }
    
    const delta = (parsed as OpenAIStreamResponse).choices?.[0]?.delta?.content;
    return typeof delta === "string"? delta : undefined;
}


export async function* streamChat(options: ChatOptions): AsyncGenerator<ChatStreamEvent> {
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
          stream: true,
        }),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
          yield {type: "aborted", partialText: ""};
          return;
      }
           
      const message = error instanceof Error ? error.message : String(error);
  
      yield {
          type: "error",
          message: `Network error while calling ${url}: ${message}`,
          partialText: "",
      }
      return;
    }
    
      //2.检查HTTP状态
    if (!response.ok) {
      const body = await response.text();
      const detail = body.slice(0, 500).trim();

      yield {
          type: "error",
          message: `Chat request failed: ${response.status} ${response.statusText}${detail ? `\n${detail}` : ""}`,
          partialText: "",
      }
      return;
    }
    
    if(!response.body) {
        yield {type: "error",message: "Chat response had no body.",partialText: ""};
        return;
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    let buffer = "";
    let fullText = "";
    let finished = false;
    
    try {
        while (!finished) {
            const {done, value} = await reader.read();
            if(done)
                break;
                
            buffer += decoder.decode(value, {stream: true});
            buffer = buffer.replace(/\r\n/g,"\n");//win中结尾不是\n\n而是\r\n\r\n
            
            while(true) {
                const boundary = buffer.indexOf("\n\n");
                if(boundary === -1)
                    break;
                    
                const rawEvent = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                
                const data = readSseData(rawEvent);
                
                if(!data) continue;//挡掉没有data行和空心跳
                
                if (data === "[DONE]") {
                    finished = true;
                    break;
                }
                
               const delta = parseDelta(data);
                
                if(delta) {
                    fullText += delta;
                    yield {type: "text",delta};
                }
            }
        }
        
        buffer += decoder.decode(); // EOF 冲刷：最后一个事件可能没有以 \n\n 结尾
        
        if(buffer.trim().length > 0) {
            const data = readSseData(buffer);
            
            if(data && data !== "[DONE]") {
                const delta = parseDelta(data);
                
                if (delta) {
                    fullText += delta;
                    yield {type: "text", delta};
                }
            }
        }
        
        if (options.signal?.aborted) {
            yield { type: "aborted", partialText: fullText };
            return;
        }
        
        
        yield {type:"done",text:fullText};
    } catch(error) {
      if (options.signal?.aborted) {
              yield {type: "aborted", partialText: fullText};
      } else {
            const message = error instanceof Error ? error.message : String(error);
            yield {type: "error",message,partialText: fullText};
        }
    } finally {
        reader.releaseLock();
    }
}
