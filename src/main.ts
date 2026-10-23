const VERSION = "0.1.0";

function main(): void {
    const args = process.argv.slice(2);
    
    if(args.includes("--help") || args.includes("-h")){
        console.log(`my-pi ${VERSION}`);
        console.log("");
        console.log("Usage:");
        console.log("  npm run dev -- <prompt>");
        return;
    }
    
    console.log(`my-pi ${VERSION}`);
    console.log(`args: ${JSON.stringify(args)}`);
}

main();