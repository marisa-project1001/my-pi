import type { ChatMessage } from "./ai/types";

export const DEFAULT_SYSTEM_PROMPT = "You are a concise coding assistant.";

export interface BuildMessagesOptions {
    prompt: string;
    system?: string;
}

export function buildMessages(options: BuildMessagesOptions): ChatMessage[] {
    return [
        {
            role: "system",
            content:options.system ?? DEFAULT_SYSTEM_PROMPT,
        },
        {
            role: "user",
            content: options.prompt,
        },
    ];
}