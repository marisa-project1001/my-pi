const VERSION = "0.1.0";
import { AppConfig, loadConfig } from "./config";
import { chatOnce, ChatOnceOptions } from "./ai/openai";

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    
    if(args.includes("--help") || args.includes("-h")){
        console.log(`my-pi ${VERSION}`);
        console.log("");
        console.log("Usage:");
        console.log("  npm run dev -- <prompt>");
        return;
    }
    
    const prompt = args.join(" ").trim();
    if(!prompt) {
        console.error("Usage: npm run dev -- <prompt>");
        process.exitCode = 1;
        return;
    }
    
    const appConfig: AppConfig = loadConfig();
    const chatOnceOptions: ChatOnceOptions = {
        apiKey:appConfig.apiKey,
        baseUrl:appConfig.baseUrl,
        model:appConfig.model,
        messages:[
            {role: "system",content:"You are a concise coding assistant"},
            {role: "user",content: prompt},
        ],
    };
    
    const result = await chatOnce(chatOnceOptions);
    
    console.log(result.text);
}

main().catch((error:unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
})