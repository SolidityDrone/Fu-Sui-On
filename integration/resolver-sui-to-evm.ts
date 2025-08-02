#!/usr/bin/env ts-node

// Import and run the demo
import { demonstrateResolver } from './resolver/index';

// Run the demo and keep process alive
async function main() {
    try {
        await demonstrateResolver();

        // Keep the process alive
        process.stdin.resume();

        // Handle Ctrl+C gracefully
        process.on('SIGINT', () => {
            console.log('\n👋 Goodbye!');
            process.exit(0);
        });
    } catch (error) {
        console.error('❌ Error:', error);
        process.exit(1);
    }
}

main();