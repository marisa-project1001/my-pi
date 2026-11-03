import type { ChatToolCall } from "./ai/types";
import { TOOLS, runTool } from "./tools";

/*
    工具执行层:负责编排工具
*/

export type ToolEvent =
    | { type: "tool_start"; id: string; name: string; args: string }
    | { type: "tool_end"; id: string; name: string; ok: boolean; ms: number; chars: number; output: string; };

export interface ToolCallResult {
    call: ChatToolCall;
    output: string;
    ok: boolean;
    ms: number;
}

export interface RunToolCallsOptions {
    onEvent?: (event: ToolEvent) => void;
    concurrency?: number;
    signal?: AbortSignal;
}

const DEFAULT_CONCURRENCY = 4;
const ABORTED_SKIP = "[aborted] 用户取消,工具未执行.";
//只读工具才能并行
function isReadOnly(name: string): boolean {
    return TOOLS.find((item) => item.definition.name === name)?.readOnly === true;
}

function succeed(output: string): boolean {
    return !output.startsWith("[tool_error]");
}

async function runBatch(
    batch: ChatToolCall[],
    results: ToolCallResult[],
    offset: number,
    options: RunToolCallsOptions,
): Promise<void> {
    const limit = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
    let next = 0;

    // 固定的worker 从队列领活, 比promise.all更容易加上限
    const worker = async (): Promise<void> => {
        for (; ;) {
            const index = next++;
            if (index >= batch.length)
                return;

            const call = batch[index];

            if (options.signal?.aborted) {
                results[offset + index] = { call, output: ABORTED_SKIP, ok: false, ms: 0 };
                continue;
            }



            const startedAt = Date.now();

            options.onEvent?.({ type: "tool_start", id: call.id, name: call.name, args: call.arguments });

            const output = await runTool(call.name, call.arguments, options.signal);
            const ms = Date.now() - startedAt;
            const ok = !options.signal?.aborted && succeed(output);

            options.onEvent?.({ type: "tool_end", id: call.id, name: call.name, ok, ms, chars: output.length, output });
            results[offset + index] = { call, output, ok, ms };
        }
    }

    const workers = Array.from({ length: Math.min(limit, batch.length) }, () => worker());
    await Promise.all(workers);
}

export async function runToolCalls(
    calls: ChatToolCall[],
    options: RunToolCallsOptions = {},
): Promise<ToolCallResult[]> {
    const results: ToolCallResult[] = new Array(calls.length);
    let index = 0;

    while (index < calls.length) {
        if (isReadOnly(calls[index].name)) {
            //寻找连续的一串只读任务并行
            let end = index;
            while (end < calls.length && isReadOnly(calls[end].name))
                end++;

            await runBatch(calls.slice(index, end), results, index, options);
            index = end;
        } else {
            await runBatch(calls.slice(index, index + 1), results, index, options);
            index++;
        }
    }

    return results;
}