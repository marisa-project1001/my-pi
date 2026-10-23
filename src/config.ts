export interface AppConfig {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly model: string;
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export function loadConfig(): AppConfig {
    const envPath = resolve(process.cwd(),".env");//resolve将括号内的路径片段解析为绝对路径,process.cwd是node的当前的工作目录
    if(existsSync(envPath)) {
        process.loadEnvFile(envPath);
    }
    
    const apiKey = process.env.OPENAI_API_KEY?.trim();//trim()可以删除字符串的首尾空格,变量不存在时由于"?"会产生undefined不会崩掉
    if(!apiKey)
        throw new ConfigError("api_key is EMPTY!!Add it to .env or export it in your shell");
    
    const model = process.env.PI_MODEL?.trim();
    if(!model)
        throw new ConfigError("model name is EMPTY!!Add it to .env or export it in your shell");
        
    const rawBaseUrl = process.env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE_URL;
        
    let parsed: URL;

    try{
        parsed = new URL(rawBaseUrl);
    } catch {
        throw new ConfigError(
             `Invalid OPENAI_BASE_URL: "${rawBaseUrl}". It must be a full URL, for example https://api.openai.com/v1.`
        );
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ConfigError(
            `Invalid OPENAI_BASE_URL: "${rawBaseUrl}". It must start with http:// or https://.`
        );
    }
    
    const baseUrl = 
    rawBaseUrl.replace(/\/+$/,"");//正则表达式,删除网址末尾的若干'/'
    
    if(baseUrl.endsWith("/chat/completions") || baseUrl.endsWith("/chat"))
    {
        throw new ConfigError(
            "OPENAI_BASE_URL must be the API root, not the full endpoint. Remove /chat/completions or /chat"
        )
    }
    
    return {apiKey,baseUrl,model};
}



export function maskSecret(secret:string): string {
    if(secret.length <= 12) return "***";
    return `${secret.slice(0,4)}...${secret.slice(-4)}`;
}//屏蔽敏感字符串
