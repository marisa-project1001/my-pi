import { loadConfig, maskSecret } from "./config";


try{
    const config = loadConfig();
    console.log("config ok");
    console.log(`baseUrl: ${config.baseUrl}`);
    console.log(`model: ${config.model}`);
    console.log(`apiKey: ${maskSecret(config.apiKey)}`);
} catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    
    console.error(`Config error: ${message}`);
    process.exitCode = 1;
}