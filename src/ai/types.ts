export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
    role: ChatRole;
    content: string;
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

export type ChatStreamEvent = 
    | {type: "text"; delta: string} 
    | {type: "done"; text: string}
    | {type: "error"; message: string; partialText: string}
    | {type: "aborted"; partialText: string};
    