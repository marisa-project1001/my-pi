const VERSION = "0.2.0";
import { AppConfig, loadConfig } from "./config";
import { chatOnce, ChatOptions, streamChat } from "./ai/openai";
import {  createHistory } from "./messages";
import * as readline from "node:readline/promises";
import { ChatMessage } from "./ai/types";

interface CliOptions {
    prompt: string;
    system?: string;
    showMessages: boolean;
    stream: boolean;
}

interface RunContext {
    config: AppConfig;
    history: ChatMessage[];
    showMessages: boolean;
}

let currentController: AbortController | null = null;
let exitFromIdle: (()=>void) | null = null;//空闲时怎么退出

process.on("SIGINT",()=>{
    if (currentController) {
        currentController.abort();
        return;
    }
    
    
    if (exitFromIdle) {
        exitFromIdle();
        return;
    }
    
    process.exit(130);
});


function parseArgs(argv: string[]): CliOptions {
    let system: string | undefined;
    let showMessages = false;
    let stream = false;
    const rest: string[] = [];
    
    for (let i = 0;i < argv.length;i++) {
        const arg = argv[i];
        
        if(arg === "--system") {
            system = argv[++i];
            if(!system) {
                throw new Error("--system requires a value");
            }
        } else if (arg === "--show-messages") {
            showMessages = true;
        } else if (arg === "--stream") {
            stream = true;
        }
        else {
            rest.push(arg);
        }
    }
    
    return {
        prompt: rest.join(" ").trim(),
        system,
        showMessages,
        stream,
    };
}//解析终端参数

function showHistory(history: ChatMessage[]): void {
    console.log("--- messages ---");
    for (const message of history) {
        console.log(`[${message.role}] ${message.content}`);
    };
    console.log("------------------");
}//打印对话历史

interface ReplCommand {
    help: string;
    run: (ctx: RunContext) => boolean | void;
}

function printHelp(): void {
    console.log("可用命令: ");
    
    for (const [name, command] of commands) {
        console.log(`  ${name.padEnd(8)}${command.help}`);
    }
}

function printStats(history: ChatMessage[]): void {
    const chars = history.reduce((sum, message) => sum + message.content.length, 0);
    const turns = history.filter((message) => message.role === "user").length;
    
    console.log(
        `历史 ${history.length} 条 / ${turns} 轮 / ${chars} 字符（粗估 ${Math.ceil(chars / 2)} tokens）`,
    );
}

const commands = new Map<string,ReplCommand>([
    ["/help",{help: "显示这个列表",run: () => { printHelp();}}],
    [
        "/clear",
        {
            help: "清空对话历史,只保留system",
            run: (ctx) => {
                const removed = Math.max(ctx.history.length - 1,0);
                ctx.history.length = 1;//直接截断,数组引用不变
                console.log(`已清空 ${removed} 条历史,system 保留.`);
            },
        },
    ],
    ["/stats",{ help: "查看历史条数与长度", run: (ctx) => {printStats(ctx.history)}}],
    ["/exit",{ help: "退出", run: () => true}],
])


//单轮流式对话
async function runTurn(ctx: RunContext, input: string): Promise<"ok" | "aborted" | "error"> {
    ctx.history.push({role: "user", content: input});
    
    if (ctx.showMessages) {
        showHistory(ctx.history);
    }
    
    const controller = new AbortController();
    currentController = controller;
    
    try{
        const chatOptions: ChatOptions = {
              apiKey: ctx.config.apiKey,
              baseUrl: ctx.config.baseUrl,
              model: ctx.config.model,  
              messages: [...ctx.history],
              signal: controller.signal,
        };
    
        let finalText = "";
        let ok = false;
        let aborted = false;
        
        for await (const event of streamChat(chatOptions)) {
            if (event.type === "text") {
                process.stdout.write(event.delta);
            } else if (event.type === "done") {
                finalText = event.text;
                ok = true;
                process.stdout.write("\n");
            } else if (event.type === "aborted") {
                aborted = true;
                
                if(event.partialText.length > 0) {
                    process.stderr.write("\n");
                }
                
                process.stderr.write("Aborted.\n");
            } else {
                if (event.partialText.length > 0) {
                    process.stderr.write("\n");
                }
                
                process.stderr.write(`Error: ${event.message}\n`);
            }
        }
        
        if(ok) {
            ctx.history.push({role: "assistant", content: finalText});
            return "ok";
        }
        
        ctx.history.pop();
        return aborted ? "aborted" : "error";
    } finally {
        currentController = null;
    }
}

//单次非流式
async function runOnce(ctx: RunContext, prompt: string): Promise<void> {
    ctx.history.push({role: "user",content: prompt});
    
    if (ctx.showMessages){
        showHistory(ctx.history);
    }
    
    const controller = new AbortController();
    currentController = controller;
    
    try {
        const result = await chatOnce({
              apiKey: ctx.config.apiKey,
              baseUrl: ctx.config.baseUrl,
              model: ctx.config.model,  
              messages: [...ctx.history],
              signal: controller.signal,
        });
    
        console.log(result.text);
        ctx.history.push({role: "assistant",content: result.text });
    } catch (error) {
        ctx.history.pop();
        
        if (controller.signal.aborted) {
            process.exitCode = 130;
            return;
        }//aborted
        
        throw error;//error
    } finally {
        currentController = null;
    }
}    

//最小REPL

async function runRepl(ctx: RunContext): Promise<void> { 
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    exitFromIdle = (() => rl.close());
    
    try {
        for(;;) {
            let line: string | null = null;
            
            try {
                line = (await rl.question("> ")).trim();
            } catch {
                line = null;// rl 被关掉（Ctrl+C 或输入结束）
            }
            
            if (line === null) {
                break;
            }
            
            if (line.length === 0) {
                continue;
            }
            
            //斜杠命令
            if (line.startsWith("/")) {
                const command = commands.get(line);
                
                if (!command) {
                    console.log(`未知命令: ${line}, 输入 /help 查看可用命令`);
                    continue;
                }
                
                if (command.run(ctx) === true) {
                    break;
                }
                
                continue;
            }
            
            if (line === "/exit" || line === "/quit" || line === "exit") {
                break;
            }
            
            const outcome = await runTurn(ctx, line);
            
            if (outcome === "error") {
                process.exitCode = 1;
            }
        }
    } finally {
        exitFromIdle = null;
        rl.close();
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    
    if(args.includes("--help") || args.includes("-h")){
        console.log(`my-pi ${VERSION}`);
        console.log("");
        console.log("Usage:");
        console.log("  npm run dev                                        # 交互模式(多轮对话)")
        console.log("  npm run dev -- <prompt>                            # 单次回答");
        console.log('  npm run dev -- --system "<instruction>" <prompt>');
        console.log("  npm run dev -- --show-messages <prompt>            # 每轮请求前打印完整历史");
        console.log("  npm run dev -- --stream <prompt>                   # 单次问答，流式输出");
        return;
    }
    
    const options = parseArgs(args);
    const appConfig: AppConfig = loadConfig();
    const history = createHistory(options.system);
    
    const ctx: RunContext = {
        config: appConfig,
        history,
        showMessages: options.showMessages,
    };

    if(!options.prompt) {
        await runRepl(ctx);
        return;
    }
    
    if (options.stream) {
        const outcome = await runTurn(ctx, options.prompt);
        
        if (outcome === "aborted") {
            process.exitCode = 130;
        } else if (outcome === "error") {
            process.exitCode = 1;
        }
        
        return;
    }
    
    await runOnce(ctx, options.prompt);
}

main().catch((error:unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
})