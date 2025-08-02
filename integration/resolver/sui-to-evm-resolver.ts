import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createWalletClient, createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';

import { WebSocketHandler } from './websocket-handler';
import { SuiHandler } from './sui-handler';
import { EvmHandler } from './evm-handler';
import { CrossChainOrder } from './types';

// Load environment variables
dotenv.config();

// Create a single global client instance
const client = new SuiClient({ url: getFullnodeUrl('testnet') });

export class SuiToEvmResolver extends EventEmitter {
    private wsHandler: WebSocketHandler;
    private suiHandler: SuiHandler;
    private evmHandler: EvmHandler;
    private orders: Map<string, CrossChainOrder> = new Map();
    private ordersToFill: number | null = null;
    private ordersFilled: number = 0;

    // Sui setup
    public bobKeypair: Ed25519Keypair;
    private suiClient: SuiClient;

    // EVM setup
    private evmPublicClient: any;
    private evmWalletClient: any;
    private evmAccount: any;
    private evmFactoryAddress: `0x${string}`;

    // Contract addresses
    private PACKAGE_ID: string;
    private FACTORY_ID: string;
    private FACTORY_VERSION: string;

    constructor(url: string = 'ws://localhost:8080') {
        super();

        // Initialize Bob's keypair for gas sponsorship
        const bobPrivateKey = process.env.BOB_PRIVATE_KEY;
        if (!bobPrivateKey) {
            throw new Error('BOB_PRIVATE_KEY not found in environment variables');
        }
        this.bobKeypair = Ed25519Keypair.fromSecretKey(bobPrivateKey);
        this.suiClient = client;

        // Initialize EVM provider and wallet with VIEM
        const bobEthPrivateKeyRaw = process.env.BOB_ETH_PRIVATE_KEY;
        if (!bobEthPrivateKeyRaw) {
            throw new Error('BOB_ETH_PRIVATE_KEY not found in environment variables');
        }

        // Ensure private key has 0x prefix for VIEM
        const bobEthPrivateKey = bobEthPrivateKeyRaw.startsWith('0x')
            ? bobEthPrivateKeyRaw as `0x${string}`
            : `0x${bobEthPrivateKeyRaw}` as `0x${string}`;

        this.evmAccount = privateKeyToAccount(bobEthPrivateKey);

        this.evmPublicClient = createPublicClient({
            chain: baseSepolia,
            transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
        });

        this.evmWalletClient = createWalletClient({
            account: this.evmAccount,
            chain: baseSepolia,
            transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
        });

        this.evmFactoryAddress = (process.env.BASE_ESCROW_FACTORY || '0x6e7F7f50Ce82F1A49e9F9292B1EF1538E5B52d1A') as `0x${string}`;

        // Load contract addresses from environment
        this.PACKAGE_ID = process.env.SRC_PACKAGE_ID as string;
        this.FACTORY_ID = process.env.SRC_FACTORY_ID as string;
        this.FACTORY_VERSION = process.env.SRC_FACTORY_VERSION as string;

        // Orders to fill will be set when first order arrives

        // Initialize handlers
        this.wsHandler = new WebSocketHandler(url);
        this.suiHandler = new SuiHandler(
            this.suiClient,
            this.bobKeypair,
            this.PACKAGE_ID,
            this.FACTORY_ID,
            this.FACTORY_VERSION
        );
        this.evmHandler = new EvmHandler(
            this.evmPublicClient,
            this.evmWalletClient,
            this.evmAccount,
            this.evmFactoryAddress
        );

        this.setupEventHandlers();
    }

    /**
     * Setup event handlers
     */
    private setupEventHandlers(): void {
        // WebSocket events
        this.wsHandler.on('connected', () => {
            this.emit('connected');
        });

        this.wsHandler.on('disconnected', () => {
            this.emit('disconnected');
        });

        this.wsHandler.on('error', (error: Error) => {
            this.emit('error', error);
        });

        // Order events
        this.wsHandler.on('order_created', (data) => {
            this.handleNewOrder(data);
        });

        this.wsHandler.on('existing_order', (data) => {
            this.handleNewOrder(data);
        });

        this.wsHandler.on('maker_signature_received', (data) => {
            // Update the order with the maker signature
            const order = this.orders.get(data.orderId);
            if (order) {
                order.makerSignature = data.makerSignature;
                this.orders.set(data.orderId, order);

                console.log(`   ✅ Updated order with maker signature`);
                console.log(`   🚀 Proceeding with Sui escrow deployment...`);

                // Continue with escrow deployment now that we have the signature
                console.log(`🚀 Continuing with Sui escrow deployment...`);
                this.sponsorAndDeploySuiEscrow(order).then(suiEscrowId => {
                    if (suiEscrowId) {
                        console.log(`🎉 Successfully deployed Sui escrow for order ${order.orderId}`);
                        console.log(`   Sui Escrow ID: ${suiEscrowId}`);

                        // Store the Sui escrow ID in the order
                        order.suiEscrowId = suiEscrowId;
                        this.orders.set(order.orderId, order);

                        // Step 2: Deploy EVM escrow
                        console.log(`\n🔧 Step 2: Deploying EVM escrow for ${order.partsToFill}/${order.totalParts} parts`);
                        this.evmHandler.deployEvmEscrow(order).then(evmEscrowAddress => {
                            if (evmEscrowAddress) {
                                console.log(`🎉 Successfully deployed EVM escrow for order ${order.orderId}`);
                                console.log(`   EVM Escrow Address: ${evmEscrowAddress}`);

                                // Increment filled orders counter
                                this.ordersFilled++;
                                if (this.ordersFilled >= this.ordersToFill!) {
                                    console.log(`\n🎉 All ${this.ordersToFill} orders have been filled!`);
                                    console.log(`👋 You can press Ctrl+C to exit...`);
                                }

                                // Store the EVM escrow address in the order
                                order.evmEscrowAddress = evmEscrowAddress;
                                this.orders.set(order.orderId, order);

                                // Report deployment results to relayer for validation
                                this.wsHandler.reportDeploymentToRelayer(order.orderId, {
                                    srcEscrowSuiAddress: order.suiEscrowId,
                                    dstEvmEscrowAddress: evmEscrowAddress,
                                    chainId: 84532, // Base Sepolia chain ID
                                    hashlock: order.leafHashes?.[(order.partsToFill || 5) - 1] || '', // Dynamic hashlock index based on partsToFill
                                    partsToFill: order.partsToFill || 5, // Include partsToFill in deployment data
                                    suiTimelocks: {
                                        srcWithdrawal: order.timeWindows?.srcWithdrawal,
                                        srcPublicWithdrawal: order.timeWindows?.srcPublicWithdrawal,
                                        srcCancellation: order.timeWindows?.srcCancellation
                                    },
                                    evmTimelocks: {
                                        dstWithdrawal: order.timeWindows?.dstWithdrawal,
                                        dstPublicWithdrawal: order.timeWindows?.dstPublicWithdrawal,
                                        dstCancellation: order.timeWindows?.dstCancellation
                                    }
                                });
                            }
                        });
                    }
                }).catch(error => {
                    console.error(`❌ Deployment failed after signature:`, error);
                });
            } else {
                console.log(`   ❌ Order not found: ${data.orderId}`);
            }
        });

        // Listen for authorized secrets for escrow unlocking
        this.wsHandler.on('event', (data) => {
            console.log('📡 Received event type:', data.type);

            if (data.type === 'AUTHORIZED_SECRETS') {
                this.handleAuthorizedSecrets(data);
            }
        });
    }

    /**
     * Handle new order from relayer
     */
    private async handleNewOrder(orderData: any): Promise<void> {
        console.log(`\n🔄 handleNewOrder called for order: ${orderData.orderId}`);

        // 🔍 DEBUG: Check what Alice sent
        console.log(`🔍 DEBUG: orderData.makerSignature: ${orderData.makerSignature || 'undefined'}`);
        console.log(`🔍 DEBUG: orderData.orderState?.makerSignature: ${orderData.orderState?.makerSignature || 'undefined'}`);

        // Extract order data from the nested structure
        const order: CrossChainOrder = {
            orderId: orderData.orderId,
            sourceChain: orderData.orderState?.sourceChain || orderData.sourceChain,
            destinationChain: orderData.orderState?.destinationChain || orderData.destinationChain,
            makerAddress: orderData.orderState?.makerAddress || orderData.makerAddress,
            makerEvmAddress: orderData.orderState?.makerEvmAddress || orderData.makerEvmAddress,
            makerAsset: orderData.orderState?.makerAsset || orderData.makerAsset,
            takerAsset: orderData.orderState?.takerAsset || orderData.takerAsset,
            makingAmount: orderData.orderState?.makingAmount || orderData.makingAmount,
            takingAmount: orderData.orderState?.takingAmount || orderData.takingAmount,
            totalParts: orderData.orderState?.totalParts || orderData.totalParts,
            merkleRoot: orderData.merkleRoot || orderData.orderState?.merkleRoot,
            leafHashes: orderData.orderState?.leafHashes || orderData.leafHashes,
            gaslessTransactionBytes: orderData.gaslessTransactionBytes || orderData.orderState?.gaslessTransactionBytes,
            makerSignature: orderData.makerSignature || orderData.orderState?.makerSignature,
            timeWindows: orderData.orderState?.timeWindows || orderData.timeWindows
        };

        // Only handle SUI → EVM orders
        if (order.sourceChain !== 'SUI_TESTNET' || order.destinationChain !== 'BASE_SEPOLIA') {
            console.log(`⏭️  Skipping order ${order.orderId} (not SUI → EVM)`);
            console.log(`   Expected: SUI_TESTNET → BASE_SEPOLIA`);
            console.log(`   Received: ${order.sourceChain} → ${order.destinationChain}`);
            return;
        }

        console.log(`\n🎯 Processing SUI → EVM order: ${order.orderId}`);
        console.log(`   Maker (Sui): ${order.makerAddress}`);
        console.log(`   Maker (EVM): ${order.makerEvmAddress || 'Not provided'}`);
        console.log(`   Amount: ${order.makingAmount} SUI → ${order.takingAmount} USDC`);
        console.log(`   Parts: ${order.totalParts}`);
        console.log(`   Merkle Root: ${order.merkleRoot}`);
        console.log(`   Leaf Hashes: ${order.leafHashes?.length || 0} received`);
        if (order.leafHashes && order.leafHashes.length > 4) {
            console.log(`   🔐 Leaf hash for part 5 (index 4): ${order.leafHashes[4]}`);
        }

        // Store order
        this.orders.set(order.orderId, order);

        // Show order amount
        const takingAmountUsd = parseFloat(order.takingAmount) / 1000000; // USDC has 6 decimals
        console.log(`💰 Order amount: $${takingAmountUsd.toFixed(2)} USDC`);
        console.log(`🎯 Order has ${order.totalParts} total parts`);

        // If this is the first order, ask how many orders to fill
        if (this.ordersToFill === null) {
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });

            this.ordersToFill = await new Promise<number>((resolve) => {
                readline.question('\nHow many orders would you like to fill? ', (answer: string) => {
                    readline.close();
                    const num = parseInt(answer);
                    resolve(isNaN(num) || num < 1 ? 1 : num);
                });
            });

            console.log(`\n🎯 Will attempt to fill ${this.ordersToFill} orders`);
        }

        // Check if we've already filled enough orders
        if (this.ordersFilled >= this.ordersToFill!) {
            console.log(`⏭️  Skipping order (already filled ${this.ordersFilled}/${this.ordersToFill} orders)`);
            return;
        }

        console.log(`📊 Progress: ${this.ordersFilled + 1}/${this.ordersToFill} orders`);

        // Ask for parts to fill
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const partsToFill = await new Promise<number>((resolve) => {
            readline.question(`\nHow many parts would you like to fill? (1-${order.totalParts}): `, (answer: string) => {
                readline.close();
                const num = parseInt(answer);
                if (isNaN(num) || num < 1) {
                    console.log(`⚠️  Invalid input, defaulting to 5 parts`);
                    resolve(5);
                } else if (num > order.totalParts) {
                    console.log(`⚠️  Requested ${num} parts but order only has ${order.totalParts} parts`);
                    console.log(`   Adjusting to fill ${order.totalParts} parts instead`);
                    resolve(order.totalParts);
                } else {
                    resolve(num);
                }
            });
        });

        console.log(`\n🎯 Will fill ${partsToFill}/${order.totalParts} parts`);

        try {
            // Store parts to fill in the order for later use
            order.partsToFill = partsToFill;
            this.orders.set(order.orderId, order);

            // Step 1: Deploy Sui escrow
            const suiEscrowId = await this.sponsorAndDeploySuiEscrow(order);
            if (!suiEscrowId) {
                console.log(`   ⏳ Waiting for escrow deployment to complete...`);
            }

        } catch (error: any) {
            console.error(`❌ Failed to process order ${order.orderId}:`, error);
        }
    }

    /**
     * Sponsor and deploy Sui escrow - signature flow
     */
    public async sponsorAndDeploySuiEscrow(order: CrossChainOrder): Promise<string | null> {
        console.log(`🔍 DEBUG: sponsorAndDeploySuiEscrow called for order: ${order.orderId}`);
        console.log(`🔍 DEBUG: order.makerSignature exists: ${!!order.makerSignature}`);

        // Check if we already have the maker's signature
        if (!order.makerSignature) {
            console.log(`🔐 No maker signature yet - creating transaction for signing`);

            // Create transaction for signing
            await this.suiHandler.createTransactionForSigning(order);

            // Send finalTxBytes to relayer for maker to sign
            const finalTxBytes = this.suiHandler.getStoredTransaction(order.orderId);
            if (finalTxBytes) {
                console.log(`📤 Sending finalTxBytes to relayer for maker to sign`);
                await this.wsHandler.sendTransactionForSigning(order.orderId, finalTxBytes);
            }

            return null;
        } else {
            console.log(`🔐 Maker signature received - executing transaction`);
            return await this.suiHandler.executeTransactionWithSignature(order);
        }
    }

    /**
     * Handle authorized secrets from relayer
     */
    private async handleAuthorizedSecrets(secretsData: any): Promise<void> {
        console.log(`\n🔐 RESOLVER: Received authorized secrets for order: ${secretsData.orderId}`);
        console.log(`   Message: ${secretsData.message}`);
        console.log(`   🔓 Revealed secrets (0-4): ${secretsData.secretsData.revealedSecrets?.length || 0} provided`);
        console.log(`   🌳 Hashed leaves (5-10): ${secretsData.secretsData.hashedLeaves?.length || 0} provided`);
        console.log(`   🔓 EVM secret: ${secretsData.secretsData.evmSecret ? 'Provided' : 'Missing'}`);

        try {
            // Get the order data
            const order = this.orders.get(secretsData.orderId);
            if (!order) {
                console.error(`❌ Order ${secretsData.orderId} not found in resolver`);
                return;
            }

            console.log(`🔓 Starting escrow unlocking process...`);

            // Step 1: Unlock Sui escrow with range withdrawal (dynamic secrets based on partsToFill)
            await this.suiHandler.unlockSuiEscrow(order, secretsData.secretsData, order.partsToFill!);

            // Step 2: Unlock EVM escrow with single secret (dynamic secret index based on partsToFill)
            await this.evmHandler.unlockEvmEscrow(order, secretsData.secretsData);

            console.log(`🎉 Escrow unlocking completed for order ${secretsData.orderId}!`);

        } catch (error) {
            console.error(`❌ Failed to unlock escrows for order ${secretsData.orderId}:`, error);
        }
    }

    /**
     * Subscribe to all orders
     */
    async subscribeToAllOrders(): Promise<any> {
        return this.wsHandler.subscribeToAllOrders();
    }

    /**
     * Get all orders
     */
    async getAllOrders(): Promise<any> {
        return this.wsHandler.getAllOrders();
    }

    /**
     * Get resolver configuration info
     */
    getConfig() {
        return {
            PACKAGE_ID: this.PACKAGE_ID,
            FACTORY_ID: this.FACTORY_ID,
            evmFactoryAddress: this.evmFactoryAddress,
            evmWalletAddress: this.evmAccount.address
        };
    }

    /**
     * Close connection
     */
    close(): void {
        this.wsHandler.close();
    }
}