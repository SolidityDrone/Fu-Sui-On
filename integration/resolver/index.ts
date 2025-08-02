#!/usr/bin/env ts-node

import { SuiToEvmResolver } from './sui-to-evm-resolver';

// Main resolver demo
async function demonstrateResolver() {
    console.log('🎯 SUI → EVM Resolver');
    console.log('='.repeat(40));

    const resolver = new SuiToEvmResolver();

    // Wait for connection
    await new Promise<void>((resolve) => {
        resolver.on('connected', resolve);
    });

    try {
        // Subscribe to all orders
        console.log('📡 Subscribing to all orders...');
        await resolver.subscribeToAllOrders();
        console.log('✅ Subscribed to all orders');

        // Get existing orders
        console.log('\n📋 Getting existing orders...');
        const orders = await resolver.getAllOrders();
        console.log(`✅ Found ${orders.length} existing orders`);

        // Show resolver info
        const config = resolver.getConfig();
        console.log('\n🔧 Resolver Configuration:');
        console.log(`   Sui Package ID: ${config.PACKAGE_ID}`);
        console.log(`   Sui Factory ID: ${config.FACTORY_ID}`);
        console.log(`   EVM Factory: ${config.evmFactoryAddress}`);
        console.log(`   EVM Wallet: ${config.evmWalletAddress}`);

        // Keep connection alive and wait for orders
        console.log('\n⏳ Waiting for SUI → EVM orders to fill...');
        console.log('   Press Ctrl+C to exit');

    } catch (error) {
        console.error('❌ Error:', error);
        resolver.close();
    }
}

// Export for use in other files
export { SuiToEvmResolver, demonstrateResolver };

// Run demo if this file is executed directly
if (require.main === module) {
    demonstrateResolver().catch(console.error);
}