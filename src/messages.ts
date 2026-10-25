import type { ChatMessage } from "./ai/types";

export const DEFAULT_SYSTEM_PROMPT = "You are a concise coding assistant.";

export function createHistory(system?: string): ChatMessage[] {
    return [
        {
            role: "system",
            content: system ?? DEFAULT_SYSTEM_PROMPT,
        },
    ]
}