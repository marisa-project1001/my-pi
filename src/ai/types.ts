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