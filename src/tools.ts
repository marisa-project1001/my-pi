import { spawn } from "node:child_process";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, dirname, join } from "node:path";
import type { ToolDefinition } from "./ai/types";
import { existsSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";

export interface Tool {
    definition: ToolDefinition;
    timeoutMs?: number;
    run: (args: Record<string, unknown>) => Promise<string>;
}

interface SchemaProperty { type?: string; description?: string;}
interface ObjectSchema {
    type?: string;
    properties?: Record<string, SchemaProperty>;
    required?: string[];
}

const MAX_READ_CHARS = 50000;// 给个上限防止撑爆上下文
const MAX_READ_LINES = 2000;
const TOOL_TIMEOUT_MS = Number(process.env.PI_TOOL_TIMEOUT_MS ?? 15000);//工具调用超时
const MAX_WRITE_CHARS = 200000;/// 防止模型一次灌进超大内容
const BASH_TIMEOUT_MS = Number(process.env.PI_BASH_TIMEOUT_MS ?? 30000);
const MAX_OUTPUT_CHARS = 30000;
const SPILL_DIR = join(".pi", "tool-output");//落盘位置

await mkdir(join(process.cwd(), SPILL_DIR), {recursive: true});

// 不要依赖 PATH 里的裸名字：Windows 上 `bash` 可能是 WSL 的应用执行别名，
// 隐藏窗口里 spawn 会直接 EACCES（errno -4092），跟命令内容无关
function resolveShell(): string {
    if (process.env.PI_SHELL) {
        if (!existsSync(process.env.PI_SHELL)) {
            console.warn(`[warn] PI_SHELL 指向不存在的文件：${process.env.PI_SHELL}`);
        }
        return process.env.PI_SHELL;
    }

    if (process.platform !== "win32") return "/bin/sh";

    const candidates = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        "D:\\soft\\Git\\bin\\bash.exe",
        process.env.LOCALAPPDATA + "\\Programs\\Git\\bin\\bash.exe",
    ];

    for (const candidate of candidates) {
        if (candidate && existsSync(candidate)) return candidate;
    }

    // 再扫一遍 PATH，但跳过 WindowsApps（那里的 bash 是 WSL 应用别名，spawn 必 EACCES）
    for (const dir of (process.env.PATH ?? "").split(";")) {
        if (!dir || /WindowsApps/i.test(dir)) continue;
        const p = join(dir, "bash.exe");
        if (existsSync(p)) return p;
    }

    console.warn(`[warn] 没找到 Git bash，退回到 ${process.env.ComSpec}：中文可能乱码、ls/grep 不可用`);
    return process.env.ComSpec ?? "cmd.exe";
}

const SHELL = resolveShell();

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

//统一截断出口,将所有长输出都在这个函数过一遍
function truncateWithNote(text: string, maxChars: number, more: string): string {
    if (text.length <= maxChars)
        return text;
        
    const cut = text.lastIndexOf("\n", maxChars);
    const shown = text.slice(0, cut > 0 ? cut : maxChars);
    const totalLines = text.split("\n").length;
    const shownLines = shown.split("\n").length;
    
    return `${shown}\n[truncated] 只显示前 ${shown.length}/${text.length} 字符(${shownLines}/${totalLines} 行). ${more}`;
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
    if (reason.includes("路径越界")) return "只能访问工作目录内的文件，去掉 ../ 或改用相对路径。";
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
                offset: {type: "number", description: "从第几行开始读(从1数起),默认1;看到[truncated]时用它翻页"},
                limit: {type: "number", description: `最多读多少行,默认 ${MAX_READ_LINES}`},
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
        const lines = text.split("\n");
        
        const offset = Math.max(1, Math.floor(Number(args.offset ?? 1)) || 1);
        const limit = args.limit === undefined ? MAX_READ_LINES : Math.max(1, Math.floor(Number(args.limit)) || MAX_READ_LINES);
        
        if (offset > lines.length) {
            return `[提示] 文件共 ${lines.length} 行, offset ${offset} 超出范围.`;
        }
        
        const startIndex = offset - 1;
        const endIndex = Math.min(startIndex + limit, lines.length);
        const picked: string[] = [];
        let chars = 0;
        
        for (let i = startIndex; i < endIndex; i++) {
            const cost = lines[i].length + 1;//+1是换行符
            if (picked.length > 0 && chars + cost > MAX_READ_CHARS)
                break;
            picked.push(lines[i]);
            chars += cost;
        }
        
        if (picked.length === 1 && picked[0].length > MAX_READ_CHARS) {
            const line = picked[0];
            const more = lines.length > offset 
                ? ` 下一行: read({"path":"${path}","offset":${offset + 1}})`
                : "";
            return line.slice(0, MAX_READ_CHARS) + `\n[truncated] 第 ${offset} 行本身有 ${line.length} 字符,只显示 ${MAX_READ_CHARS} 个. ${more}`;
        }
        
        const shownEnd = startIndex + picked.length;
        let body = picked.join("\n");
        
        if (shownEnd < lines.length) {
            body += `\n[truncated] 文件共 ${lines.length} 行,本次显示第 ${offset}-${shownEnd} 行. 继续读:read("path":"${path}","offset":${shownEnd + 1})`;
        } else if (offset > 1) {
            body += `\n[info] 已显示到文件末尾(共 ${lines.length} 行).`;
        }
        
        return body;
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

export const WRITE_TOOL: Tool = {
    definition: {
        name: "write",
        description: "把内容写入工作目录内的文件,不存在则构建,存在则覆盖原文件,注意是覆盖!!",
        parameters: {
            type: "object",
            properties: {
                path: {type: "string",description: "相对工作目录的文件地址,如notes/todo.md"},
                content: {type: "string", description: "要写入的完整内容(UTF-8)"},
            },
            required: ["path","content"],
        },
    },
    
    async run(args) {
        const path = args.path;
        const content = args.content;
        
        if (typeof path !== "string" || path.length === 0) {
            throw new Error("缺少参数 path");
        }
        
        if (typeof content !== "string") {
            throw new Error("缺少参数 content");
        }
        
        if (content.length > MAX_WRITE_CHARS) {
            throw new Error(`内容过长: ${content.length} 字符, 上限为 ${MAX_WRITE_CHARS} 字符`);
        }
        
        const full = insideWorkspace(path);
        
        //先看原文件有没有内容
        let existed = false;
        let previousBytes = 0;
        
        try {
            previousBytes = (await stat(full)).size;
            existed = true;
        } catch {
            //文件不存在,走新建
        }
        
        await mkdir(dirname(full), { recursive: true});
        await writeFile(full, content, "utf8");
        
        const lines = content.split("\n").length;
        const bytes = Buffer.byteLength(content, "utf8");
        const action = existed ? `覆盖(原 ${previousBytes} 字节 -> 新 ${bytes} 字节)` : "新建";
        
        return `已写入 ${path}: ${action}, ${content.length} 字符  / ${lines} 行 / ${bytes} 字节`;
    }
}

function makeDiff(before: string,  after: string, context = 2): string {
    const a = before.split("\n");
    const b = after.split("\n");
    
    let start = 0;
    
    while(start < a.length && start < b.length && a[start] === b[start])
        start++;
        
    let endA = a.length - 1;
    let endB = b.length - 1;
    
    while(endA >= start && endB >= start && a[endA] === b[endB]) {
        endA--;
        endB--;
    }
    
    const out: string[] = [];
    const from = Math.max(0, start - context);
    
    for (let i = from; i < start;++i)
        out.push(" " + a[i]);
    for (let i = start; i <= endA;++i)
        out.push("-" + a[i]);
    for (let i = start;i <= endB;++i)
        out.push("+" +b[i]);
        
    const to = Math.min(b.length - 1, endB + context);
    for (let i = endB + 1;i <= to; ++i) {
        if (b[i] === "" && i === b.length - 1)//末尾空行不做上下文
            break;
        out.push(" " + b[i]);
    }
        
    return `@@ 第 ${start + 1} 行 @@\n` + out.join("\n");       
}

export const EDIT_TOOL: Tool = {
    definition: {
        name: "edit",
        description: "把文件里的一段原文替换为新文本;oldText必须在文件中恰好出现一次,否则拒绝",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "相对工作目录的文件路径"},
                oldText: { type: "string", description: "要被替换的原文(必须唯一,建议带上下文)"},
                newText: {type: "string", description: "替换成的新文本;传空文本表示删除这段"},
            },
            required: ["path", "oldText", "newText"],
        },
    },
    
    async run(args) {
        const path = args.path;
        const oldText = args.oldText;
        const newText = args.newText;
        
        if (typeof path !== "string" || path.length === 0)
            throw new Error("path为空!");
        if (typeof oldText !== "string" || oldText.length === 0)
            throw new Error("缺少参数oldText(不能为空)");
        if (typeof newText !== "string")
            throw new Error("缺少参数 newText");
            
        const full = insideWorkspace(path);
        const raw = await readFile(full, "utf8");
        
        if (raw.length > MAX_WRITE_CHARS) {
            throw new Error(`文件过大(${raw.length} 字符), edit 只适合改小文件`);
        }
        
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const before = raw.replace(/\r\n/g,"\n");
        const needle = oldText.replace(/\r\n/g, "\n");
        const replacement = newText.replace(/\r\n/g, "\n");
        
        const first = before.indexOf(needle);
        const second = first === -1 ? -1 : before.indexOf(needle, first + 1);//唯一性确认
        
        if (first === -1) {
            return formatError("edit", "没有找到 oldText", `文件共 ${before.split("\n").length} 行,先用 read 看清原文（空白与缩进也要一致）再改.`)
        }
        
        if (second !== -1) {
            const count = before.split(needle).length - 1;
            return formatError("edit", `oldText在原文中出现了 ${count} 次,无法确定修改位置`, "多带几行上下文,让它在整个文件里唯一.");
        } 
        
        const afterLf = before.slice(0, first) + replacement + before.slice(first + needle.length);
        
        const after = eol === "\r\n" ? afterLf.replace(/\n/g, "\r\n") : afterLf;
        
        await writeFile(full, after, "utf8");
        
        const lineNo = before.slice(0, first).split("\n").length;
        const removed = needle.split("\n").length;
        const added = replacement.split("\n").length;
        
        const summary = `已编辑 ${path}: 第 ${lineNo} 行, - ${removed} 行 / + ${added} 行\n`;
        
        return summary + truncateWithNote(makeDiff(before, afterLf), MAX_OUTPUT_CHARS, `用 read({"path":"${path}","offset":${Math.max(1, lineNo - 2)}}) 查看改动区域.`);
    }
}

//递归删除进程树
function killTree(pid: number | undefined): void {
    if(!pid)
        return;
        
    if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
            detached: true,
        });
        killer.on("error", () => {});
        killer.unref();
        return;
    }
    
    try {
        process.kill(-pid, "SIGKILL");
    } catch {

    }
}

export const BASH_TOOL: Tool = {
    definition: {
        name: "bash",
        description: "在工作目录下执行一条 shell 命令, 返回合并后的输出与退出码.会真实修改文件系统，执行前先想清楚.",
        parameters: {
            type: "object",
            properties: {
                command: {type: "string", description: "要执行的命令,如ls -la src"},
                timeoutMs: {type: "number", description: "可选,超时毫秒数,默认 30000, 上限 120000" },
            },
            required: ["command"],
        },
    },
    
    timeoutMs: BASH_TIMEOUT_MS + 5000,
        
    async run(args) {
        const command = args.command;
        
        if (typeof command !== "string" || command.trim().length === 0) {
            throw new Error("缺少参数 command");
        }
        
        const timeoutMs = Math.min(Number(args.timeoutMs ?? BASH_TIMEOUT_MS), 120000);
        
        
        return await new Promise<string>((resolve) => {
            const child = spawn(command, {
                shell: SHELL,
                cwd: process.cwd(),
                windowsHide: true,
                detached: process.platform !== "win32", // POSIX 下按进程组杀
            });
            
            let output = "";
            let truncated = false;
            let timedOut = false;
            let done = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let totalBytes = 0;
            let spill: WriteStream | null = null;
            let spillFailed = false;
            let spillPath = "";
            let tailBuf = "";
            
            const append = (chunk: Buffer): void => {
                if (done)
                    return;
                    
                totalBytes += chunk.length;
                
                if (spill) {
                    spill.write(chunk);
                    tailBuf = (tailBuf + chunk.toString("utf8")).slice(-4000);
                    return;
                }//已经确认spill了，数据文件    
                
                output += chunk.toString("utf8");
                
                if (output.length > MAX_OUTPUT_CHARS) {
                    spillPath = join(SPILL_DIR, `bash-${Date.now()}.log`);
                    spill = createWriteStream(spillPath);
                    spill.write(output);
                    spill.on("error", ()=> {
                        spillFailed = true;
                        spill = null;
                    });
                    output = output.slice(0, MAX_OUTPUT_CHARS);
                    truncated = true;
                }
            };
            
            const finish = (code: number | null): void => {
                if (done)
                    return;
                done = true;
                if (timer)
                    clearTimeout(timer);
                
                let body = output.length > 0 && !output.endsWith("\n") ? output + "\n" : output;
                const notes: string[] = [];
                
                if (timedOut)
                    notes.push(`[timeout] 超过 ${timeoutMs}ms, 已结束进程树.`);
                if (truncated) {
                    const shownPath = spillPath.replaceAll("\\", "/");
                    notes.push(`[truncated] 输出超过 ${MAX_OUTPUT_CHARS} 字符，完整内容已落盘：${shownPath}（用 read 分段查看，或 bash + grep 搜关键词）`);  notes.push(`......中间省略...(完整内容用read分段查看,或bash + grep 搜关键词)`);
                      body = body + "\n" + tailBuf;               
                }

                if (!timedOut && code !== 0)
                    notes.push(`[exit ${code}] 命令失败`)
                    
                const result = body + (notes.length > 0 ? notes.join("\n") : "[exit 0]");
                
                if (spill) {
                    spill.end(() => resolve(result));
                } else {
                    resolve(result);
                }
            } 
            

            
            child.stdout?.on("data", append);
            child.stderr?.on("data", append);
            
            timer = setTimeout(() => {
                timedOut = true;
                killTree(child.pid);
                finish(null);
            }, timeoutMs);
            
            child.on("error", (error) => {
                if (done)
                    return;
                done = true;
                if (timer)
                    clearTimeout(timer);
                resolve(formatError("bash", error.message, `检查 SHELL 是否能成功(当前: ${SHELL}), 或使用PI_SHELL指定.`));
            })
            
            child.on("close", (code) => finish(code));
        });
    },
};


//工具在这里注册,不会再有第二个工具信息副本,方便维护
export const TOOLS: Tool[] = [READ_TOOL, ECHO_TOOL, SLOW_TOOL, WRITE_TOOL, EDIT_TOOL, BASH_TOOL];
export const TOOL_DEFINITIONS: ToolDefinition[] = TOOLS.map((item) => (item.definition)); 


/*
执行工具调用永远返回字符串,直接输回模型
*/
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
        return await withTimeout(tool.run(args), tool.timeoutMs ?? TOOL_TIMEOUT_MS);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return formatError(name, reason, hintFor(reason, tool.definition));
    }
}
