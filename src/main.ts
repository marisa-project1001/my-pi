const VERSION = "0.1.0";
import { AppConfig, loadConfig } from "./config";
import { chatOnce, ChatOptions, streamChat } from "./ai/openai";
import { buildMessages } from "./messages";

interface CliOptions {
    prompt: string;
    system?: string;
    showMessages: boolean;
    stream: boolean;
}

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
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    
    if(args.includes("--help") || args.includes("-h")){
        console.log(`my-pi ${VERSION}`);
        console.log("");
        console.log("Usage:");
        console.log("  npm run dev -- <prompt>");
        console.log('  npm run dev -- --system "<instruction>" <prompt>');
        console.log("  npm run dev -- --show-messages <prompt>");
        console.log("  npm run dev -- --stream <prompt>");
        return;
    }
    
    const options = parseArgs(args);
    const prompt = options.prompt;
    if(!prompt) {
        console.error("Usage: npm run dev -- [--system <instruction>] [--show-messages] <prompt>");
        process.exitCode = 1;
        return;
    }
    
    const appConfig: AppConfig = loadConfig();
    const messages = buildMessages({
        prompt,
        system: options.system,
    });

    if(options.showMessages) {
        for(const message of messages) {
            console.log(`[${message.role}] ${message.content}`);
        }
        console.log("");
    }
    
    const chatOptions = {
        apiKey: appConfig.apiKey,
        baseUrl: appConfig.baseUrl,
        model: appConfig.model,
        messages,
    }
    
    if(options.stream) {
        for await (const event of streamChat (chatOptions)) {
            if(event.type === "text") {
                process.stdout.write(event.delta);
            } else {
                process.stdout.write("\n");
            }
        }
    } else {
        const result = await chatOnce(chatOptions);
        console.log(result.text);
    }
}

main().catch((error:unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
})