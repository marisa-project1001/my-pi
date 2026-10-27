import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolDefinition } from "./ai/types";

export interface Tool {
    definition: ToolDefinition;
    run: (args: Record<string, unknown>) => Promise<string>;
}

interface SchemaProperty { type?: string; description?: string;}
interface ObjectSchema {
    type?: string;
    properties?: Record<string, SchemaProperty>;
    required?: string[];
}

const MAX_CHARS = 20000;// 给个上限防止撑爆上下文
const TOOL_TIMEOUT_MS = Number(process.env.PI_TOOL_TIMEOUT_MS ?? 15000);//工具调用超时

function insideWorkspace(input: string): string {
    const root = process.cwd();
    const full = resolve(root, input);
    const rel = relative(root, full);
    
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`路径越界: ${input} 不在工作目录内`);
    }
    
    return full;
}

function formatError(tool: string, reason: string, hint?: string): string {
    const lines = [`[tool_error] ${tool}`, `reason: ${reason}`];
    if (hint)
        lines.push(`hint: ${hint}`);
    return lines.join("\n");
}

function exampleArgs(definition: ToolDefinition): string {
    const schema = definition.parameters as ObjectSchema;
    const example: Record<string, unknown> =  {};
    
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        if (prop.type === "number")
            example[key] = 0;
        else if (prop.type === "boolean")
            example[key] = false;
        else example[key] = "字符串";
    }
    
    return JSON.stringify(example);
}

//schema校验
function validateArgs(definition: ToolDefinition, args: Record<string, unknown>): string | null {
    const schema = definition.parameters as ObjectSchema;
    
    for (const key of schema.required ?? []) {
        if (!(key in args))
            return `缺少必填参数 ${key}`;
    }
    
    for (const [key, value] of Object.entries(args)) {
        const prop = schema.properties?.[key];
        if (!prop)
            return `出现未声明的参数 ${key}`;
            
        const actual = Array.isArray(value) ? "array" : typeof value;
        
        if (prop.type && prop.type !== actual)
            return `参数 ${key} 应为 ${prop.type}, 实际是 ${actual}`;
    }
    
    return null;
}

async function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    
    const guard = new Promise<T>((_,reject) => {
        timer = setTimeout(() => reject(new Error(`执行超过 ${ms}ms, 已停止等待,底层操作可能仍在跑`)), ms);
    });

    try {
        return await Promise.race([task, guard]);
    } finally {
        if (timer)
            clearTimeout(timer);
    }
}

//把底层错误翻译成"可操作的建议"
function hintFor(reason: string, definition: ToolDefinition): string {
    if (reason.includes("ENOENT")) return "文件不存在：检查路径拼写，路径必须相对当前工作目录且在目录内。";
    if (reason.includes("EACCES")) return "没有读取权限。";
    if (reason.includes("EISDIR")) return "这是一个目录，read 只能读文件。";
    if (reason.includes("路径越界")) return "只能读工作目录内的文件，去掉 ../ 或改用相对路径。";
    if (reason.includes("执行超过")) return "缩小工作量或换个参数再试。";
    return `正确调用形状：${definition.name}(${exampleArgs(definition)})`;
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

export const SLOW_TOOL: Tool = {
    definition: {
        name: "slow",
        description: "睡指定的毫秒数后返回;用于测试超时与取消",
        parameters: {
            type: "object",
            properties: {
                ms: { type: "number", description: "要睡多少毫秒"},
            },
            required: ["ms"],
        },
    },
    
    async run(args) {
        const ms = Number(args.ms ?? 0);
        await new Promise((done) => setTimeout(done, ms));
        return `睡了 ${ms}ms`;
    },
}

export const TOOLS: Tool[] = [READ_TOOL, ECHO_TOOL, SLOW_TOOL];

export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((item) => (item.definition)); 


/*执行工具调用永远返回字符串*/

export async function runTool(name: string, rawArguments: string): Promise<string> {
    const tool = TOOLS.find((item) => item.definition.name === name);
    
    if(!tool)
        return formatError(name, "没有这个工具", ` 可用工具: ${TOOLS.map((item) => item.definition.name).join(", ")}`);
        
    let parsed: unknown;
    
    try {
        parsed = JSON.parse(rawArguments.length > 0 ? rawArguments : "{}");
    } catch {
        return formatError(name, `参数不是合法 JSON: ${rawArguments.slice(0 ,120)}`, `正确形状: ${exampleArgs(tool.definition)}`);
    }
    
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return formatError(name, `参数必须是 JSON 对象`, `正确形状: ${exampleArgs(tool.definition)}`)
    }
    
    const args = parsed as Record<string, unknown>;
    const invalid = validateArgs(tool.definition, args);
    
    if (invalid) {
        return formatError(name, invalid, `正确形状: ${exampleArgs(tool.definition)}`);
    }
    
    try {
        return await withTimeout(tool.run(args), TOOL_TIMEOUT_MS);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return formatError(name, reason, hintFor(reason, tool.definition));
    }
}
