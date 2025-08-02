#!/usr/bin/env ts-node

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { keccak256, toHex, hexToBytes } from 'viem'
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree'
import * as crypto from 'crypto'
import * as dotenv from 'dotenv'

// Load environment variables - look in parent directory as well
dotenv.config()


// Types for WebSocket communication
interface RelayerMessage {
    type: 'CREATE_ORDER' | 'EXECUTE_ORDER' | 'GET_ORDERS' | 'GET_ORDER_STATUS' | 'SUBSCRIBE_EVENTS' | 'PROVIDE_SECRETS'
    id: string
    data: any
    clientType?: 'MAKER' | 'TAKER'
}

interface RelayerResponse {
    type: 'ORDER_CREATED' | 'ORDER_EXECUTED' | 'ORDER_STATUS' | 'ORDERS_LIST' | 'EVENT' | 'ERROR'
    id: string
    success: boolean
    data: any
    error?: string
}

class SuiToEvmClient extends EventEmitter {
    private ws: WebSocket
    private connected: boolean = false
    private messageId: number = 0
    private pendingRequests: Map<string, { resolve: Function, reject: Function }> = new Map()
    private secrets: Uint8Array[] = []
    private merkleRoot: Uint8Array | null = null
    private orderId: string | null = null
    private orders: Map<string, any> = new Map()
    // Removed suiClient - resolver handles all Sui interactions
    private aliceKeypair: Ed25519Keypair
    private signedTransactionBytes: Uint8Array | null = null

    constructor(url: string = 'ws://localhost:8080') {
        super()
        this.ws = new WebSocket(url)

        // Initialize keypair only - resolver handles all Sui interactions
        console.log(`🌐 MAKER CLIENT: Starting up - resolver handles all Sui operations`)
        console.log(`🌐 MAKER CLIENT: Connecting to relayer at ${url}`)

        // Load Alice's private key from environment
        const alicePrivateKey = process.env.ALICE_PRIVATE_KEY
        if (!alicePrivateKey) {
            throw new Error('ALICE_PRIVATE_KEY not found in environment variables')
        }

        // Parse Sui private key (it's in base64 format, not hex)
        this.aliceKeypair = Ed25519Keypair.fromSecretKey(alicePrivateKey)

        this.setupWebSocket()
    }

    /**
     * Setup WebSocket connection
     */
    private setupWebSocket(): void {
        this.ws.on('open', () => {
            this.connected = true
            console.log('🔌 MAKER CLIENT: Connected to relayer')
            this.emit('connected')
        })

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const response: RelayerResponse = JSON.parse(data.toString())
                this.handleResponse(response)
            } catch (error) {
                console.error('❌ Error parsing response:', error)
            }
        })

        this.ws.on('close', () => {
            this.connected = false
            console.log('🔌 Disconnected from relayer')
            this.emit('disconnected')
        })

        this.ws.on('error', (error: Error) => {
            console.error('❌ WebSocket error:', error)
            this.emit('error', error)
        })
    }

    /**
     * Handle responses from relayer
     */
    private handleResponse(response: RelayerResponse): void {
        console.log(`📨 Response: ${response.type} (${response.success ? '✅' : '❌'})`)

        // Handle pending requests
        const pending = this.pendingRequests.get(response.id)
        if (pending) {
            this.pendingRequests.delete(response.id)
            if (response.success) {
                pending.resolve(response.data)
            } else {
                pending.reject(new Error(response.error || 'Unknown error'))
            }
        }

        // Emit events for real-time updates
        this.emit(response.type.toLowerCase(), response.data)

        // Log response details
        if (response.type === 'ORDER_CREATED') {
            console.log(`   Order ID: ${response.data.orderId}`)
            this.orderId = response.data.orderId
            // Make sure we store the order data with the orderId
            if (response.data.orderId && !this.orders.has(response.data.orderId)) {
                console.log(`   📝 Storing order data with ID: ${response.data.orderId}`);
                this.orders.set(response.data.orderId, {
                    ...response.data,
                    orderId: response.data.orderId
                });
            }
        } else if (response.type === 'ORDER_EXECUTED') {
            console.log(`   Order ID: ${response.data.orderId}`)
            console.log(`   Success: ${response.data.success}`)
        } else if (response.type === 'EVENT') {
            console.log(`   Event: ${JSON.stringify(response.data, null, 2)}`)
        }
    }

    /**
     * Send message to relayer
     */
    private sendMessage(message: RelayerMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                reject(new Error('Not connected to relayer'))
                return
            }

            this.pendingRequests.set(message.id, { resolve, reject })
            this.ws.send(JSON.stringify(message))
        })
    }

    /**
     * Generate unique message ID
     */
    private generateMessageId(): string {
        return `msg_${++this.messageId}_${Date.now()}`
    }

    /**
     * Generate OpenZeppelin Merkle tree (same as working Sui demo)
     */
    async generateSecrets(totalParts: number): Promise<void> {
        console.log(`🎲 Generating ${totalParts + 1} random secrets for ${totalParts} parts...`)

        // Generate N+1 random secrets (32 bytes each)
        this.secrets = []

        // Add timestamp to ensure unique secrets for each escrow instance
        const timestamp = Date.now()
        console.log(`   Timestamp for unique secrets: ${timestamp}`)

        for (let i = 0; i < totalParts + 1; i++) {
            // Generate random 32-byte secret using crypto.randomBytes + timestamp for uniqueness
            const randomBytes = crypto.randomBytes(28) // 28 bytes for randomness
            const timestampBytes = new Uint8Array(4)
            const timestampView = new DataView(timestampBytes.buffer)
            timestampView.setUint32(0, timestamp + i, true) // 4 bytes for timestamp (little endian) + index

            // Combine random bytes + timestamp for unique secret
            const secret = new Uint8Array(32)
            secret.set(randomBytes, 0)
            secret.set(timestampBytes, 28)

            this.secrets.push(secret)
        }

        // FIXED: Hash secrets first to create secure leaves (like the fixed demo)
        // Convert ONLY the first totalParts secrets to hashed leaves for SimpleMerkleTree
        // The extra secret (totalParts + 1) is not used in the merkle tree
        const merkleTreeSecrets = this.secrets.slice(0, totalParts); // Only use first totalParts secrets
        const leafHashes = merkleTreeSecrets.map(secret => keccak256(secret))

        console.log(`   🌳 Building merkle tree from ${merkleTreeSecrets.length} secrets (0-${totalParts - 1})`);
        console.log(`   📊 Extra secret at index ${totalParts} not used in merkle tree`);

        // Build tree with SimpleMerkleTree - CRITICAL: sortLeaves: false to preserve order
        const ozTree = SimpleMerkleTree.of(leafHashes, { sortLeaves: false })

        // Get root
        this.merkleRoot = hexToBytes(ozTree.root as `0x${string}`)

        console.log(`🌳 Merkle Root: ${toHex(this.merkleRoot)}`)
        console.log(`🔐 Generated ${this.secrets.length} secrets (not revealed yet)`)

        // Log first and last secrets for reference
        console.log(`   First secret: ${toHex(this.secrets[0])}`)
        console.log(`   Last secret: ${toHex(this.secrets[this.secrets.length - 1])}`)
    }

    /**
     * Create a SUI → EVM cross-chain order (INTENT ONLY - no transaction creation)
     */
    async createSuiToEvmOrder(request: {
        makerAddress: string
        makerAsset: string
        takerAsset: string
        makingAmount: string
        takingAmount: string
        totalParts?: number
        timeWindows?: {
            srcWithdrawal: number
            srcPublicWithdrawal: number
            srcCancellation: number
            dstWithdrawal: number
            dstPublicWithdrawal: number
            dstCancellation: number
        }
    }): Promise<any> {
        // Generate secrets first (same as working example)
        const totalParts = request.totalParts || 10
        await this.generateSecrets(totalParts)

        // MAKER ONLY SENDS INTENT - resolver will reconstruct and create transaction
        console.log(`📤 Sending INTENT ONLY to relayer (resolver will reconstruct transaction)`)
        console.log(`   Maker Address: ${request.makerAddress}`)
        console.log(`   Merkle Root: ${toHex(this.merkleRoot!)}`)
        console.log(`   Amount: ${request.makingAmount} MIST (${parseInt(request.makingAmount) / 1000000000} SUI)`)

        // Get Alice's EVM address from environment (optional for now)
        const aliceEvmAddress = process.env.ALICE_EVM_ADDRESS
        if (!aliceEvmAddress) {
            console.log(`   ⚠️  ALICE_EVM_ADDRESS not found in environment variables`)
            console.log(`   ⚠️  Using placeholder EVM address for testing`)
        } else {
            console.log(`   Alice EVM Address: ${aliceEvmAddress}`)
        }

        // Calculate leaf hashes from the first totalParts secrets (consistent with merkle tree)
        const merkleTreeSecrets = this.secrets.slice(0, totalParts);
        const allLeafHashes = merkleTreeSecrets.map(secret => keccak256(secret))
        console.log(`   🔐 Generated ${allLeafHashes.length} leaf hashes from first ${totalParts} secrets`)

        // Send all leaf hashes from the merkle tree - resolver can pick what he needs
        const leafHashesForResolver = allLeafHashes
        console.log(`   📋 Sending ${leafHashesForResolver.length} leaf hashes to resolver`)
        if (leafHashesForResolver.length > 4) {
            console.log(`   📋 Leaf hash for part 5 (index 4): ${leafHashesForResolver[4]}`)
        }

        // Create order data
        const orderData = {
            sourceChain: 'SUI_TESTNET',
            destinationChain: 'BASE_SEPOLIA',
            makerAddress: request.makerAddress,
            makerEvmAddress: aliceEvmAddress || '0x0000000000000000000000000000000000000001', // Add Alice's EVM address or placeholder
            makerAsset: request.makerAsset,
            takerAsset: request.takerAsset,
            makingAmount: request.makingAmount,
            takingAmount: request.takingAmount,
            totalParts,
            merkleRoot: toHex(this.merkleRoot!),
            leafHashes: leafHashesForResolver, // Send leaf hashes (safe to share)
            // NO TRANSACTION BYTES - resolver will create everything
            timeWindows: request.timeWindows || {
                srcWithdrawal: Math.floor(Date.now() / 1000) + 3600,
                srcPublicWithdrawal: Math.floor(Date.now() / 1000) + 7200,
                srcCancellation: Math.floor(Date.now() / 1000) + 1800,
                dstWithdrawal: Math.floor(Date.now() / 1000) + 3600,
                dstPublicWithdrawal: Math.floor(Date.now() / 1000) + 7200,
                dstCancellation: Math.floor(Date.now() / 1000) + 1800
            }
        };

        const message: RelayerMessage = {
            type: 'CREATE_ORDER',
            id: this.generateMessageId(),
            data: orderData,
            clientType: 'MAKER'
        }

        // Send message and store order data
        const response = await this.sendMessage(message);

        // Store order data with orderId from response
        if (response.orderId) {
            console.log(`   📝 Storing order data with ID: ${response.orderId}`);
            this.orderId = response.orderId; // Also update current orderId
            this.orders.set(response.orderId, {
                ...orderData,
                orderId: response.orderId
            });
        }

        return response
    }

    // createGaslessTransaction method removed - resolver handles all transaction creation

    /**
     * Sign the final sponsored transaction and send signature back to resolver
     */
    async signSponsoredTransaction(finalTransactionBytes: Uint8Array): Promise<void> {
        console.log(`🔐 Signing final sponsored transaction`)

        const aliceSignature = await this.aliceKeypair.signTransaction(finalTransactionBytes)

        const message: RelayerMessage = {
            type: 'EXECUTE_ORDER',
            id: this.generateMessageId(),
            data: {
                orderId: this.orderId,
                makerSignature: aliceSignature.signature, // Send directly, no base64 conversion
                clientType: 'MAKER'
            },
            clientType: 'MAKER'
        }

        await this.sendMessage(message)
        console.log(`📤 Sent maker signature to relayer for resolver`)
    }

    /**
     * Get secrets for a specific range (only when resolver needs them)
     */
    getSecretsForRange(startIndex: number, endIndex: number): Uint8Array[] {
        if (!this.secrets.length) {
            throw new Error('No secrets generated yet')
        }

        if (startIndex < 0 || endIndex >= this.secrets.length || startIndex > endIndex) {
            throw new Error('Invalid range')
        }

        return this.secrets.slice(startIndex, endIndex + 1)
    }

    /**
     * Get merkle root
     */
    getMerkleRoot(): string {
        if (!this.merkleRoot) {
            throw new Error('No merkle root generated yet')
        }
        return toHex(this.merkleRoot)
    }

    /**
     * Get order ID
     */
    getOrderId(): string | null {
        return this.orderId
    }

    /**
     * Provide secrets for escrow unlocking
     */
    async provideSecretsForUnlocking(orderId: string, suiEscrowAddress: string, resolverWantsToFill?: number): Promise<void> {
        console.log(`🔐 Providing secrets for order: ${orderId}`)
        console.log(`   Sui Escrow: ${suiEscrowAddress}`)

        if (!this.secrets.length) {
            throw new Error('No secrets generated yet')
        }

        // Get the order to know total parts
        console.log(`   🔍 Looking for order ${orderId} in ${this.orders.size} stored orders...`);
        const order = Array.from(this.orders.values()).find(o => o.orderId === orderId);
        if (!order) {
            console.log(`   ❌ Available order IDs: ${Array.from(this.orders.keys()).join(', ')}`);
            throw new Error(`Order ${orderId} not found`);
        }
        console.log(`   ✅ Found order with ${order.totalParts} total parts`);

        // SECURE APPROACH: Reveal secrets based on how many parts the resolver wants to fill
        // Use provided value or default to half of total parts
        const partsToFill = resolverWantsToFill || Math.floor(order.totalParts / 2);
        console.log(`   📊 Resolver wants to fill ${partsToFill} parts`);

        const secretsToReveal = this.secrets.slice(0, partsToFill) // Secrets 0 to partsToFill-1
        const secretsToKeepSecret = this.secrets.slice(partsToFill, order.totalParts) // Secrets partsToFill to totalParts-1
        console.log(`   📊 Using ${order.totalParts} out of ${this.secrets.length} generated secrets for merkle tree`);
        const hashedLeavesForProof = secretsToKeepSecret.map(secret => keccak256(secret)) // Hash remaining secrets
        const evmSecret = this.secrets[partsToFill - 1] // Last secret that resolver will use for EVM withdrawal

        console.log(`   🔓 Revealing secrets 0-${partsToFill - 1}: ${secretsToReveal.length} raw secrets`)
        console.log(`   🔐 Keeping secrets ${partsToFill}-${order.totalParts - 1} private: ${secretsToKeepSecret.length} secrets`)
        console.log(`   🌳 Sharing hashed leaves ${partsToFill}-${order.totalParts - 1}: ${hashedLeavesForProof.length} hashes`)
        console.log(`   🔓 Secret for EVM withdrawal (${partsToFill - 1}): ${toHex(evmSecret)}`)

        // Verify that our partial data can reconstruct the original merkle root
        const reconstructedLeafHashes = [
            ...secretsToReveal.map(secret => keccak256(secret)), // Hash revealed secrets
            ...hashedLeavesForProof // Already hashed leaves
        ];
        const reconstructedTree = SimpleMerkleTree.of(reconstructedLeafHashes, { sortLeaves: false });
        const reconstructedRoot = reconstructedTree.root as `0x${string}`;
        const storedRoot = toHex(this.merkleRoot!);
        console.log(`   🔍 Verifying partial reconstruction:`);
        console.log(`      Stored root: ${storedRoot}`);
        console.log(`      Reconstructed root: ${reconstructedRoot}`);
        console.log(`      Match: ${storedRoot === reconstructedRoot ? '✅' : '❌'}`);
        if (storedRoot !== reconstructedRoot) {
            console.log(`   ❌ WARNING: Partial data cannot reconstruct original merkle root!`);
            console.log(`   ❌ This will cause the relayer to reject the secrets.`);
        }

        // Verify merkle root consistency (full reconstruction using only totalParts secrets)
        const merkleTreeSecrets = this.secrets.slice(0, order.totalParts); // Only use first totalParts secrets
        const allLeafHashes = merkleTreeSecrets.map(secret => keccak256(secret));
        const ozTree = SimpleMerkleTree.of(allLeafHashes, { sortLeaves: false });
        const recalculatedRoot = ozTree.root as `0x${string}`;
        console.log(`   🔍 Verifying full merkle root consistency:`);
        console.log(`      Using secrets 0-${order.totalParts - 1} (${merkleTreeSecrets.length} secrets)`);
        console.log(`      Stored: ${storedRoot}`);
        console.log(`      Recalculated: ${recalculatedRoot}`);
        console.log(`      Match: ${storedRoot === recalculatedRoot ? '✅' : '❌'}`);

        const message: RelayerMessage = {
            type: 'PROVIDE_SECRETS',
            id: this.generateMessageId(),
            data: {
                orderId: orderId,
                suiEscrowAddress: suiEscrowAddress,
                merkleRoot: toHex(this.merkleRoot!), // Include merkle root for validation
                revealedSecrets: secretsToReveal.map(secret => Array.from(secret)), // First half of secrets
                hashedLeaves: hashedLeavesForProof, // Hashed leaves for second half
                evmSecret: Array.from(evmSecret) // Last secret of first half for EVM withdrawal
            },
            clientType: 'MAKER'
        }

        try {
            await this.sendMessage(message)
            console.log(`   ✅ Secrets sent to relayer for authorization`)
        } catch (error) {
            console.error(`   ❌ Failed to send secrets:`, error)
        }
    }

    /**
     * Subscribe to order events
     */
    async subscribeToEvents(orderIds: string[]): Promise<any> {
        const message: RelayerMessage = {
            type: 'SUBSCRIBE_EVENTS',
            id: this.generateMessageId(),
            data: { orderIds },
            clientType: 'MAKER'
        }

        return this.sendMessage(message)
    }

    /**
     * Get order status
     */
    async getOrderStatus(orderId: string): Promise<any> {
        const message: RelayerMessage = {
            type: 'GET_ORDER_STATUS',
            id: this.generateMessageId(),
            data: { orderId },
            clientType: 'MAKER'
        }

        return this.sendMessage(message)
    }

    /**
     * Close connection
     */
    close(): void {
        this.ws.close()
    }
}

// Main SUI → EVM demo
async function demonstrateSuiToEvm() {
    console.log('🎯 MAKER CLIENT: SUI → EVM Cross-Chain Order Demo')
    console.log('🎯 MAKER CLIENT: This is the MAKER script, not the resolver!')
    console.log('='.repeat(40))

    const client = new SuiToEvmClient()

    // Wait for connection
    await new Promise<void>((resolve) => {
        client.on('connected', resolve)
    })

    // Monitor connection status
    client.on('disconnected', () => {
        console.log('⚠️ MAKER: Disconnected from relayer!')
    })

    client.on('error', (error) => {
        console.error('⚠️ MAKER: WebSocket error:', error)
    })

    // Subscribe to events
    client.on('event', (data) => {
        console.log('📡 Received event type:', data.type)
    })

    // Note: Removed old order_executed handler - now using DEPLOYMENT_VALIDATED event instead

    // Listen for sponsored transaction signing request from resolver
    client.on('event', async (data) => {
        console.log(`🔍 MAKER: Event type detected: ${data.type}`)

        if (data.type === 'SPONSORED_TRANSACTION_READY' && data.finalTransactionBytes) {
            console.log('\n🔐 RESOLVER CREATED TRANSACTION - NEEDS MAKER SIGNATURE')
            console.log('   Final transaction bytes received from resolver via relayer')
            console.log(`   Transaction size: ${data.finalTransactionBytes.length} bytes`)

            // Convert final transaction bytes back to Uint8Array
            const finalTxBytes = new Uint8Array(data.finalTransactionBytes)
            console.log(`📥 Reconstructed transaction bytes (${finalTxBytes.length} bytes)`)

            // Sign the final sponsored transaction that resolver created
            client.signSponsoredTransaction(finalTxBytes)
                .then(() => {
                    console.log('   ✅ Maker signed resolver-created transaction')
                    console.log('   📤 Signature sent back to resolver via relayer')
                })
                .catch((error) => {
                    console.error('   ❌ Failed to sign resolver transaction:', error)
                })
        } else if (data.type === 'DEPLOYMENT_VALIDATED') {
            console.log('\n🎉 DEPLOYMENT VALIDATED BY RELAYER!')
            console.log('='.repeat(50))
            console.log(`   Order ID: ${data.orderId}`)
            console.log(`   Message: ${data.message}`)
            console.log(`   Sui Escrow: ${data.deploymentData.suiEscrowAddress}`)
            console.log(`   EVM Escrow: ${data.deploymentData.evmEscrowAddress}`)
            console.log(`   Chain ID: ${data.deploymentData.chainId}`)
            console.log(`   Hashlock: ${data.deploymentData.hashlock}`)
            console.log('='.repeat(50))
            console.log('🎯 Both escrows are now deployed and validated!')
            console.log('🎯 Ready for atomic swap execution...')

            // Now provide secrets for unlocking
            console.log('\n🔐 Providing secrets for escrow unlocking...')
            // Get the actual number of parts the resolver wants to fill from the event data
            const resolverPartsToFill = data.deploymentData.partsToFill || 5; // Get from deployment data
            console.log(`   📊 Resolver wants to fill ${resolverPartsToFill} parts`);
            await client.provideSecretsForUnlocking(data.orderId, data.deploymentData.suiEscrowAddress, resolverPartsToFill)
        } else if (data.type === 'SECRETS_AUTHORIZED') {
            console.log('\n🔐 SECRETS AUTHORIZED BY RELAYER!')
            console.log('='.repeat(50))
            console.log(`   Order ID: ${data.orderId}`)
            console.log(`   Message: ${data.message}`)
            console.log(`   Relayer Address: ${data.authorizationData.relayerAddress}`)
            console.log('='.repeat(50))
            console.log('🎯 Secrets are now authorized!')
            console.log('🎯 Resolver can now unlock both escrows...')
        } else {
            console.log('   📡 Event type not handled:', data.type)
        }
    })

    try {
        // Wait for WebSocket connection before asking for input
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Ask for number of parts first, before any other output
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log('\n📋 Order Configuration');
        const totalParts = await new Promise<number>((resolve) => {
            readline.question('How many parts would you like to create? (default: 10): ', (answer: string) => {
                readline.close();
                const num = parseInt(answer);
                if (isNaN(num) || num < 1) {
                    console.log('⚠️  Invalid input, using default: 10 parts');
                    resolve(10);
                } else {
                    resolve(num);
                }
            });
        });

        // Now show order details
        console.log('\n📝 Creating SUI → USDC order...')
        console.log(`   Parts: ${totalParts}`)
        console.log('   Trading: 0.001 SUI → 0.10 USDC')
        console.log('   Rate: ~$3.70 SUI = $0.10 USDC')

        // Get Alice's address from her keypair
        const alicePrivateKey = process.env.ALICE_PRIVATE_KEY
        if (!alicePrivateKey) {
            throw new Error('ALICE_PRIVATE_KEY not found in environment variables')
        }
        const aliceKeypair = Ed25519Keypair.fromSecretKey(alicePrivateKey)
        const aliceAddress = aliceKeypair.toSuiAddress()

        console.log(`   Maker Address: ${aliceAddress}`);

        const order = await client.createSuiToEvmOrder({
            makerAddress: aliceAddress,
            makerAsset: '0x2::sui::SUI',
            takerAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
            makingAmount: '1000000', // 0.001 SUI (1M MIST) - EXACTLY like working example
            takingAmount: '100000', // 0.10 USDC (100,000 wei with 6 decimals)
            totalParts: totalParts
        })

        console.log('✅ Order created:', order.orderId)

        // Subscribe to events for this order
        await client.subscribeToEvents([order.orderId])

        // Get order status
        console.log('\n📊 Getting order status...')
        const status = await client.getOrderStatus(order.orderId)
        console.log('✅ Order status:', status.orderState.status)

        // Show secrets info (but don't reveal them yet)
        console.log('\n🔐 Secrets Information:')
        console.log(`   Merkle Root: ${client.getMerkleRoot()}`)
        console.log(`   Total Secrets: ${client.getSecretsForRange(0, totalParts).length}`)
        console.log(`   Order ID: ${client.getOrderId()}`)

        console.log('\n⏳ Waiting for resolver to deploy atomic escrows...')
        console.log('   (Secrets will be revealed only when needed)')

        // Keep connection alive
        console.log('\n🔗 Staying connected to relayer...')
        console.log('   Press Ctrl+C to exit')

        // Keep the process alive
        process.on('SIGINT', () => {
            console.log('\n🛑 Shutting down...')
            client.close()
            process.exit(0)
        })

        // Keep the process alive indefinitely to receive events
        console.log('🔄 Entering infinite loop to stay connected...')

        // Add a heartbeat to show the maker is still alive
        setInterval(() => {
            console.log(`💓 MAKER: Still connected and waiting for events... (${new Date().toLocaleTimeString()})`)
        }, 30000) // Every 30 seconds

        await new Promise(() => { }) // This will never resolve, keeping the process alive

    } catch (error) {
        console.error('❌ Error in main flow:', error)
        console.error('❌ Stack trace:', error instanceof Error ? error.stack : 'No stack trace available')
        console.log('⚠️ Maker will stay connected despite error to receive events...')

        // Don't close the client - stay connected to receive deployment validation
        console.log('🔄 Entering infinite loop to stay connected despite error...')
        await new Promise(() => { }) // Keep alive even after error
    }
}

// Run demo if this file is executed directly
if (require.main === module) {
    demonstrateSuiToEvm().catch(console.error)
}

export { SuiToEvmClient, demonstrateSuiToEvm } 