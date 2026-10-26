import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "./ai/types";

export interface Tool {
    definition: ToolDefinition;
    run: (args: Record<string, unknown>) => Promise<string>;
}

const MAX_CHARS = 20000;// 给个上限防止撑爆上下文

function insideWorkspace(input: string): string {
    const root = process.cwd();
    const full = resolve(root, input);
    const rel = relative(root, full);
    
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`路径越界: ${input} 不在工作目录内`);
    }
    
    return full;
}

export const READ_TOOL: Tool = {
    definition: {
        name: "read",
        description: "读取工作目录内的文本文件并返回内容;适合查看源码、配置、文档",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对工作目录的文件路径,如 src/main.ts"},
            },
            required: ["path"],
        }
    },
    
    async run(args) {
        const path = args.path;
        
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("缺乏参数 path");
        }
        
        const full = insideWorkspace(path);
        const text = await readFile(full, "utf8");
        
        if (text.length > MAX_CHARS) {
            return text.slice(0, MAX_CHARS) + `\n...... (已截断, 原文共 ${text.length} 字符)`
        }
        
        return text;
    },
}

export const ECHO_TOOL: Tool = {
    definition: {
        name: "echo",
        description: "把输入的文本原样返回,  用来验证工具调用链路",
        parameters: {
            type: "object",
            properties:{
                text: {type: "string", description: "要回显的文本"},
            },
            required: ["text"],
        },
    },
    
    async run(args) {
        const text = args.text;
        if (typeof text !== "string")
            throw new Error("缺少参数 text");
        return text;
    },
}

export const TOOLS: Tool[] = [READ_TOOL, ECHO_TOOL];

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((item) => (item.definition)); 


/*执行工具调用永远返回字符串*/

export async function runTool(name: string, rawArguments: string): Promise<string> {
    const tool = TOOLS.find((item) => item.definition.name === name);
    
    if(!tool)
        return `错误:没有名为 ${name} 的工具. 可用工具: ${TOOLS.map((item) => item.definition.name).join(", ")}`;
        
    let args: Record<string, unknown>;
    
    try {
        args = JSON.parse(rawArguments.length > 0 ? rawArguments : "{}") as Record<string, unknown>;
    } catch {
        return `错误: 参数不是合法JSON: ${rawArguments}`;
    }
    
    try {
        return await tool.run(args);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `错误: ${message}`;
    }
}
