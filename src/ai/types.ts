export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
    role: ChatRole;
    content: string;
    tool_calls?: ChatToolCall[];//assistant: 它想调用什么
    tool_call_id?: string;// tool: 这条结果对应哪次调用
}

export interface ChatUsage {
    inputTokens?:number;
    outputTokens?:number;
    totalTokens?:number;
}

export interface ChatResult {
    text: string;
    model: string;
    usage?: ChatUsage;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ChatToolCall {
    id: string;
    name: string;
    arguments: string;//故意做成string,因为这一层不认识具体工具,解析参数是工具层的事
}

export type ChatStreamEvent = 
    | {type: "text"; delta: string} 
    | {type: "done"; text: string}
    | {type: "error"; message: string; partialText: string}
    | {type: "aborted"; partialText: string}
    | {type: "tool_calls"; calls: ChatToolCall[]};
    
    