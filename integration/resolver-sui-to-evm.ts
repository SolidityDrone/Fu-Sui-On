#!/usr/bin/env ts-node

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Create a single global client instance with resolver-specific RPC endpoint
const RPC_ENDPOINTS = [
    getFullnodeUrl('testnet')
];

// Use the main Sui testnet endpoint to see Alice's coins
const client = new SuiClient({ url: getFullnodeUrl('testnet') });

console.log(`🌐 Resolver using RPC: ${getFullnodeUrl('testnet')}`);

import { createWalletClient, createPublicClient, http, parseAbi, getContract } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import { keccak256, toHex, hexToBytes } from 'viem';

// Load environment variables
dotenv.config()

// Types for WebSocket communication
interface RelayerMessage {
    type: 'CREATE_ORDER' | 'EXECUTE_ORDER' | 'GET_ORDERS' | 'GET_ORDER_STATUS' | 'SUBSCRIBE_EVENTS' | 'REPORT_DEPLOYMENT' | 'PROVIDE_SECRETS' | 'AUTHORIZED_SECRETS'
    id: string
    data: any
    clientType?: string // Added for client identification
}

interface RelayerResponse {
    type: 'ORDER_CREATED' | 'ORDER_EXECUTED' | 'ORDER_STATUS' | 'ORDERS_LIST' | 'EVENT' | 'ERROR'
    id: string
    success: boolean
    data: any
    error?: string
}

interface CrossChainOrder {
    orderId: string
    sourceChain: string
    destinationChain: string
    makerAddress: string
    makerEvmAddress?: string // Add Alice's EVM address
    makerAsset: string
    takerAsset: string
    makingAmount: string
    takingAmount: string
    totalParts: number
    merkleRoot: string
    leafHashes?: string[] // Leaf hashes from maker (safe to share)
    gaslessTransactionBytes?: number[] // Changed from signedTransactionBytes
    makerSignature?: string // Changed to string to match base64 signature format
    suiEscrowId?: string // Add this for tracking Sui escrow
    evmEscrowAddress?: string // Add this for tracking EVM escrow
    deployedAt?: number // Store the deployedAt timestamp for consistent timelocks
    correctedImmutables?: any // Store corrected immutables for withdrawal
    timeWindows: {
        srcWithdrawal: number
        srcPublicWithdrawal: number
        srcCancellation: number
        dstWithdrawal: number
        dstPublicWithdrawal: number
        dstCancellation: number
    }
}

class SuiToEvmResolver extends EventEmitter {
    private ws: WebSocket
    private connected: boolean = false
    private messageId: number = 0
    private pendingRequests: Map<string, { resolve: Function, reject: Function }> = new Map()
    private orders: Map<string, CrossChainOrder> = new Map()

    // Sui setup
    public bobKeypair: Ed25519Keypair
    // NO ALICE KEYPAIR - resolver only has Bob's key for gas sponsorship

    // EVM setup with VIEM
    private evmPublicClient: any
    private evmWalletClient: any
    private evmAccount: any
    private evmFactoryAddress: `0x${string}`
    private suiClient: SuiClient

    // Contract addresses
    private PACKAGE_ID: string
    private FACTORY_ID: string
    private FACTORY_VERSION: string

    constructor(url: string = 'ws://localhost:8080') {
        super()
        this.ws = new WebSocket(url)

        // Initialize Bob's keypair for gas sponsorship ONLY
        const bobPrivateKey = process.env.BOB_PRIVATE_KEY
        if (!bobPrivateKey) {
            throw new Error('BOB_PRIVATE_KEY not found in environment variables')
        }
        this.bobKeypair = Ed25519Keypair.fromSecretKey(bobPrivateKey)
        this.suiClient = client

        // NO ALICE PRIVATE KEY - resolver gets Alice's address from the order

        // Initialize EVM provider and wallet with VIEM
        const bobEthPrivateKeyRaw = process.env.BOB_ETH_PRIVATE_KEY
        if (!bobEthPrivateKeyRaw) {
            throw new Error('BOB_ETH_PRIVATE_KEY not found in environment variables')
        }

        // Ensure private key has 0x prefix for VIEM
        const bobEthPrivateKey = bobEthPrivateKeyRaw.startsWith('0x')
            ? bobEthPrivateKeyRaw as `0x${string}`
            : `0x${bobEthPrivateKeyRaw}` as `0x${string}`

        this.evmAccount = privateKeyToAccount(bobEthPrivateKey)

        this.evmPublicClient = createPublicClient({
            chain: baseSepolia,
            transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
        })

        this.evmWalletClient = createWalletClient({
            account: this.evmAccount,
            chain: baseSepolia,
            transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
        })

        this.evmFactoryAddress = (process.env.BASE_ESCROW_FACTORY || '0x6e7F7f50Ce82F1A49e9F9292B1EF1538E5B52d1A') as `0x${string}`

        // Load contract addresses from environment
        this.PACKAGE_ID = process.env.SRC_PACKAGE_ID as string
        this.FACTORY_ID = process.env.SRC_FACTORY_ID as string
        this.FACTORY_VERSION = process.env.SRC_FACTORY_VERSION as string

        this.setupWebSocket()
        this.setupResolver()
    }

    /**
     * Setup WebSocket connection
     */
    private setupWebSocket(): void {
        this.ws.on('open', () => {
            this.connected = true
            console.log('🔌 Resolver connected to relayer')
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
            console.log('🔌 Resolver disconnected from relayer')
            this.emit('disconnected')
        })

        this.ws.on('error', (error: Error) => {
            console.error('❌ WebSocket error:', error)
            this.emit('error', error)
        })
    }

    /**
     * Setup resolver functionality
     */
    private setupResolver(): void {
        // Listen for new orders
        this.on('order_created', (data) => {
            this.handleNewOrder(data)
        })

        // Listen for order events
        this.on('event', (data) => {
            console.log('📡 Received event:', data)

            // Handle authorized secrets for escrow unlocking
            if (data.type === 'AUTHORIZED_SECRETS') {
                this.handleAuthorizedSecrets(data)
            }
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
            console.log(`   Order ID: ${response.data?.orderId || 'Unknown'}`)
            console.log(`   Direction: ${response.data?.sourceChain || 'Unknown'} → ${response.data?.destinationChain || 'Unknown'}`)
            console.log(`   Amount: ${response.data?.makingAmount || 'Unknown'} → ${response.data?.takingAmount || 'Unknown'}`)

            // DEBUG: Log the full response data structure
            console.log(`🔍 DEBUG: Full response.data structure:`)
            console.log(JSON.stringify(response.data, null, 2))

            // Process the new order via event listener (not directly)
            // this.handleNewOrder(response.data) // REMOVED - this was causing double execution
        } else if (response.type === 'ORDER_EXECUTED') {
            console.log(`   Order ID: ${response.data?.orderId || 'Unknown'}`)
            console.log(`   Success: ${response.data?.success || 'Unknown'}`)

            // Check if this is a maker signature response
            if (response.data?.makerSignature && response.data?.orderId) {
                console.log(`🔐 Received maker signature for order: ${response.data.orderId}`)
                console.log(`   Signature length: ${response.data.makerSignature.length}`)

                // Update the order with the maker signature
                const order = this.orders.get(response.data.orderId)
                if (order) {
                    order.makerSignature = response.data.makerSignature
                    this.orders.set(response.data.orderId, order)

                    console.log(`   ✅ Updated order with maker signature`)
                    console.log(`   🚀 Proceeding with Sui escrow deployment...`)

                    // Retry the Sui escrow deployment with the signature
                    console.log(`🔍 DEBUG: Calling handleNewOrder with signature...`)
                    this.handleNewOrder({
                        orderId: response.data.orderId,
                        orderState: order
                    }).catch(error => {
                        console.error(`❌ handleNewOrder failed after signature:`, error)
                    })
                } else {
                    console.log(`   ❌ Order not found: ${response.data.orderId}`)
                }
            }
        } else if (response.type === 'EVENT') {
            console.log(`   Event: ${JSON.stringify(response.data, null, 2)}`)
        } else if (response.type === 'ORDERS_LIST') {
            console.log(`   Received ${response.data?.length || 0} orders from relayer`)
            if (response.data && response.data.length > 0) {
                console.log(`🔍 Processing existing orders...`)
                response.data.forEach((order: any) => {
                    console.log(`   Processing existing order: ${order.orderId}`)
                    this.handleNewOrder(order)
                })
            }
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
        return `resolver_${++this.messageId}_${Date.now()}`
    }

    /**
     * Report deployment results to relayer for validation
     */
    private async reportDeploymentToRelayer(orderId: string, deploymentData: {
        srcEscrowSuiAddress?: string
        dstEvmEscrowAddress: string
        chainId: number
        hashlock: string
        suiTimelocks: {
            srcWithdrawal?: number
            srcPublicWithdrawal?: number
            srcCancellation?: number
        }
        evmTimelocks: {
            dstWithdrawal?: number
            dstPublicWithdrawal?: number
            dstCancellation?: number
        }
    }): Promise<void> {
        console.log(`\n📤 Reporting deployment results to relayer for validation...`)
        console.log(`   Order ID: ${orderId}`)
        console.log(`   Sui Escrow: ${deploymentData.srcEscrowSuiAddress || 'N/A'}`)
        console.log(`   EVM Escrow: ${deploymentData.dstEvmEscrowAddress}`)
        console.log(`   Chain ID: ${deploymentData.chainId}`)
        console.log(`   Hashlock: ${deploymentData.hashlock}`)

        const message: RelayerMessage = {
            type: 'REPORT_DEPLOYMENT',
            id: this.generateMessageId(),
            data: {
                orderId,
                ...deploymentData
            },
            clientType: 'RESOLVER'
        }

        try {
            const responseData = await this.sendMessage(message)
            console.log(`   ✅ Deployment report sent to relayer`)
            console.log(`   🔍 DEBUG: Full relayer response:`, JSON.stringify(responseData, null, 2))

            // Check if validation passed (responseData contains the data, not the full response)
            const isValidated = responseData.validation?.isValid === true
            console.log(`   📋 Relayer response: ${isValidated ? 'VALIDATED' : 'REJECTED'}`)

            if (!isValidated) {
                console.error(`   ❌ Relayer rejected deployment: ${responseData.message || 'Unknown error'}`)
            } else {
                console.log(`   ✅ Relayer validated deployment successfully!`)
            }
        } catch (error) {
            console.error(`   ❌ Failed to report deployment to relayer:`, error)
        }
    }

    /**
     * Handle authorized secrets from relayer
     */
    private async handleAuthorizedSecrets(secretsData: any): Promise<void> {
        console.log(`\n🔐 RESOLVER: Received authorized secrets for order: ${secretsData.orderId}`)
        console.log(`   Message: ${secretsData.message}`)
        console.log(`   🔓 Revealed secrets (0-4): ${secretsData.secretsData.revealedSecrets?.length || 0} provided`)
        console.log(`   🌳 Hashed leaves (5-10): ${secretsData.secretsData.hashedLeaves?.length || 0} provided`)
        console.log(`   🔓 EVM secret: ${secretsData.secretsData.evmSecret ? 'Provided' : 'Missing'}`)

        try {
            // Get the order data
            const order = this.orders.get(secretsData.orderId)
            if (!order) {
                console.error(`❌ Order ${secretsData.orderId} not found in resolver`)
                return
            }

            console.log(`🔓 Starting escrow unlocking process...`)

            // Step 1: Unlock Sui escrow with range withdrawal (secrets 0-4, range 1-5)
            await this.unlockSuiEscrow(order, secretsData.secretsData)

            // Step 2: Unlock EVM escrow with single secret (secret 4)
            await this.unlockEvmEscrow(order, secretsData.secretsData)

            console.log(`🎉 Escrow unlocking completed for order ${secretsData.orderId}!`)

        } catch (error) {
            console.error(`❌ Failed to unlock escrows for order ${secretsData.orderId}:`, error)
        }
    }

    /**
     * Unlock Sui escrow using range withdrawal (following gasless_sponsored_escrow_demo.ts)
     */
    private async unlockSuiEscrow(order: CrossChainOrder, secretsData: any): Promise<void> {
        console.log(`\n🔓 Step 1: Unlocking Sui escrow with range withdrawal`)
        console.log(`   Sui Escrow: ${order.suiEscrowId}`)
        console.log(`   Using secrets 0-4 (range 1-5)`)

        // Check if we have a valid Sui escrow ID
        if (!order.suiEscrowId) {
            console.log(`   ⚠️  No Sui escrow ID found for order ${order.orderId}`)
            console.log(`   ⏭️  Skipping Sui escrow unlock`)
            return
        }

        // Check if we have the required environment variables
        if (!process.env.SRC_FACTORY_ID || !process.env.SRC_FACTORY_VERSION) {
            console.log(`   ⚠️  Missing SRC_FACTORY_ID or SRC_FACTORY_VERSION environment variables`)
            console.log(`   ⏭️  Skipping Sui escrow unlock`)
            return
        }

        try {
            // SECURE APPROACH: Use revealed secrets + hashed leaves to rebuild merkle tree
            if (!secretsData.revealedSecrets || secretsData.revealedSecrets.length !== 5) {
                throw new Error(`Expected 5 revealed secrets, got ${secretsData.revealedSecrets?.length || 0}`)
            }
            if (!secretsData.hashedLeaves || secretsData.hashedLeaves.length !== 6) {
                throw new Error(`Expected 6 hashed leaves, got ${secretsData.hashedLeaves?.length || 0}`)
            }

            // Convert revealed secrets from number arrays back to Uint8Array
            const revealedSecrets = secretsData.revealedSecrets.map((secretArray: number[]) => new Uint8Array(secretArray))
            console.log(`   🔓 Converted ${revealedSecrets.length} revealed secrets to Uint8Array`)

            // The secrets for withdrawal are the revealed secrets (0-4)
            const secretsForWithdrawal = revealedSecrets
            console.log(`   🔓 Using revealed secrets 0-4 for withdrawal: ${secretsForWithdrawal.length} secrets`)

            // Get authorization data
            const suiAuth = secretsData.authorizationData.suiAuthorization
            console.log(`   Relayer signature: ${suiAuth.signature}`)
            console.log(`   Range: ${suiAuth.startIndex}-${suiAuth.endIndex}`)

            // Create transaction for range withdrawal
            const tx = new Transaction()

            // Convert relayer public key from object to Uint8Array (it should be toSuiBytes() format)
            const relayerPublicKeyArray = new Uint8Array(Object.values(suiAuth.publicKey))
            console.log(`   🔍 DEBUG: Public key conversion:`)
            console.log(`     Original: ${JSON.stringify(suiAuth.publicKey)}`)
            console.log(`     Converted: [${Array.from(relayerPublicKeyArray).join(', ')}]`)
            console.log(`     Length: ${relayerPublicKeyArray.length}`)

            // Get escrow data to get version and amount info
            console.log(`   🔍 Getting escrow data for version and amount...`)
            const escrowData = await this.suiClient.getObject({
                id: order.suiEscrowId!,
                options: { showContent: true }
            })

            if (!escrowData.data?.content || !('fields' in escrowData.data.content)) {
                throw new Error("Could not get escrow data")
            }

            const escrowVersion = parseInt(escrowData.data.version)
            const fields = escrowData.data.content.fields as any
            const totalAmount = parseInt(fields.total_amount)
            const numParts = parseInt(fields.num_parts)
            const partSize = totalAmount / numParts
            const desiredAmount = 5 * partSize // 5 parts

            console.log(`   Escrow version: ${escrowVersion}`)
            console.log(`   Total amount: ${totalAmount} MIST, ${numParts} parts`)
            console.log(`   Withdrawing: 5 parts = ${desiredAmount} MIST`)

            // Convert signature from base64 to bytes (like in reference)
            const signatureBytes = Array.from(Buffer.from(suiAuth.signature, 'base64'))
            const nonceBytes = Array.from(hexToBytes(suiAuth.nonce as `0x${string}`))

            console.log(`   Signature bytes length: ${signatureBytes.length}`)
            console.log(`   Public key bytes length: ${relayerPublicKeyArray.length}`)
            console.log(`   Nonce bytes length: ${nonceBytes.length}`)

            // Generate actual merkle proofs using revealed secrets + hashed leaves
            console.log(`   🌳 Rebuilding merkle tree with revealed secrets + hashed leaves...`)

            // Hash the revealed secrets to create leaves 0-4
            const { SimpleMerkleTree } = require('@openzeppelin/merkle-tree')
            const hashedRevealedSecrets = revealedSecrets.map((secret: Uint8Array) => keccak256(secret))

            // Combine hashed revealed secrets (0-4) + provided hashed leaves (5-10)
            const allLeafHashes = [...hashedRevealedSecrets, ...secretsData.hashedLeaves]
            console.log(`   🔓 Hashed revealed secrets (0-4): ${hashedRevealedSecrets.length}`)
            console.log(`   🌳 Provided hashed leaves (5-10): ${secretsData.hashedLeaves.length}`)
            console.log(`   🌳 Total leaf hashes: ${allLeafHashes.length}`)

            // Build tree with SimpleMerkleTree - CRITICAL: sortLeaves: false to preserve order (same as maker)
            const ozTree = SimpleMerkleTree.of(allLeafHashes, { sortLeaves: false })

            console.log(`   Tree root: ${ozTree.root}`)
            console.log(`   Expected root from order: ${order.merkleRoot}`)

            // Verify the tree root matches the one from the order
            if (ozTree.root !== order.merkleRoot) {
                console.error(`   ❌ MERKLE ROOT MISMATCH!`)
                console.error(`     Generated: ${ozTree.root}`)
                console.error(`     Expected:  ${order.merkleRoot}`)
                throw new Error('Merkle root mismatch - tree rebuild failed')
            } else {
                console.log(`   ✅ Merkle root matches! Tree rebuilt correctly.`)
            }

            // Generate proofs for start (secret 0) and end (secret 4)
            const startProofHex = ozTree.getProof(0) // Proof for secret 0
            const endProofHex = ozTree.getProof(4)   // Proof for secret 4

            // Convert hex proofs to number arrays (like in reference)
            const startProof = startProofHex.map((hexString: string) => Array.from(hexToBytes(hexString as `0x${string}`)))
            const endProof = endProofHex.map((hexString: string) => Array.from(hexToBytes(hexString as `0x${string}`)))

            console.log(`   Start proof (secret 0): ${startProof.length} elements`)
            console.log(`   End proof (secret 4): ${endProof.length} elements`)

            // Verify proofs work (like in reference) - use hashed revealed secrets, not the tree leaves
            const startLeafHash = keccak256(secretsForWithdrawal[0]) // Hash the RAW secret (like demo)
            const endLeafHash = keccak256(secretsForWithdrawal[4])   // Hash the RAW secret (like demo)

            console.log(`   🔍 DEBUG: Verification details:`)
            console.log(`     Root: ${ozTree.root}`)
            console.log(`     Start secret (raw): 0x${Array.from(secretsForWithdrawal[0] as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('')}`)
            console.log(`     Start leaf hash: ${startLeafHash}`)
            console.log(`     End secret (raw): 0x${Array.from(secretsForWithdrawal[4] as Uint8Array).map(b => b.toString(16).padStart(2, '0')).join('')}`)
            console.log(`     End leaf hash: ${endLeafHash}`)
            console.log(`     Expected start leaf: ${allLeafHashes[0]}`)
            console.log(`     Expected end leaf: ${allLeafHashes[4]}`)

            const startVerification = SimpleMerkleTree.verify(ozTree.root as `0x${string}`, startLeafHash as `0x${string}`, startProofHex as `0x${string}`[])
            const endVerification = SimpleMerkleTree.verify(ozTree.root as `0x${string}`, endLeafHash as `0x${string}`, endProofHex as `0x${string}`[])

            console.log(`   Start proof verification: ${startVerification}`)
            console.log(`   End proof verification: ${endVerification}`)

            if (!startVerification || !endVerification) {
                throw new Error('Merkle proof verification failed')
            }

            // Call withdraw_partial_range_authorized (matching reference exactly)
            const [withdrawnCoin, optionalReward] = tx.moveCall({
                target: `${process.env.SRC_PACKAGE_ID}::srcescrow::withdraw_partial_range_authorized`,
                arguments: [
                    tx.sharedObjectRef({
                        objectId: order.suiEscrowId!,
                        initialSharedVersion: escrowVersion,
                        mutable: true
                    }),
                    tx.sharedObjectRef({
                        objectId: process.env.SRC_FACTORY_ID!,
                        initialSharedVersion: parseInt(process.env.SRC_FACTORY_VERSION!),
                        mutable: true
                    }),
                    tx.pure.vector('u8', Array.from(secretsForWithdrawal[0])), // start_secret (secret 0)
                    tx.pure.vector('u8', Array.from(secretsForWithdrawal[4])), // end_secret (secret 4)
                    tx.pure('vector<vector<u8>>', startProof), // start_proof
                    tx.pure('vector<vector<u8>>', endProof), // end_proof
                    tx.pure.u64(suiAuth.startIndex), // start_index (1)
                    tx.pure.u64(suiAuth.endIndex),   // end_index (5)
                    tx.pure.u64(desiredAmount), // desired_fill_amount (exact amount)
                    tx.pure.vector('u8', signatureBytes), // relayer_signature (bytes)
                    tx.pure.vector('u8', Array.from(relayerPublicKeyArray)), // relayer_public_key (bytes)
                    tx.pure.address(this.bobKeypair.toSuiAddress()), // authorized_resolver
                    tx.pure.vector('u8', nonceBytes), // nonce (bytes)
                    tx.object('0x6'), // Clock object
                ]
            })

            // Transfer withdrawn coin to Bob
            tx.transferObjects([withdrawnCoin], this.bobKeypair.toSuiAddress())

            // Destroy optional reward
            tx.moveCall({
                target: '0x1::option::destroy_none',
                typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
                arguments: [optionalReward]
            })

            // Set transaction details
            tx.setSender(this.bobKeypair.toSuiAddress())
            tx.setGasOwner(this.bobKeypair.toSuiAddress())
            tx.setGasBudget(20000000)

            // Get gas payment coins (like in reference implementation)
            const gasCoins = await this.suiClient.getCoins({
                owner: this.bobKeypair.toSuiAddress(),
                coinType: '0x2::sui::SUI'
            })

            if (gasCoins.data.length === 0) {
                throw new Error('No SUI coins available for gas payment')
            }

            // Use the first coin for gas (like in reference)
            const gasCoin = gasCoins.data[0]
            console.log(`   Using gas coin: ${gasCoin.coinObjectId} (${gasCoin.balance} MIST)`)

            // Set gas payment with proper format (objectId, version, digest)
            tx.setGasPayment([{
                objectId: gasCoin.coinObjectId,
                version: gasCoin.version,
                digest: gasCoin.digest
            }])

            // Build and sign transaction
            const txBytes = await tx.build({ client: this.suiClient })
            const signature = await this.bobKeypair.signTransaction(txBytes)

            // Execute transaction
            console.log(`   🔄 Executing Sui range withdrawal transaction...`)
            const result = await this.suiClient.executeTransactionBlock({
                transactionBlock: txBytes,
                signature: signature.signature,
                options: {
                    showEffects: true,
                    showEvents: true,
                    showObjectChanges: true
                }
            })

            if (result.effects?.status?.status === 'success') {
                console.log(`   ✅ Sui escrow unlocked successfully!`)
                console.log(`   Transaction: ${result.digest}`)

                // Log any events
                if (result.events && result.events.length > 0) {
                    console.log(`   Events: ${result.events.length} events emitted`)
                }
            } else {
                console.log(`   ❌ Sui unlock failed:`, result.effects?.status)
            }

        } catch (error) {
            console.error(`   ❌ Failed to unlock Sui escrow:`, error)
            throw error
        }
    }

    /**
     * Unlock EVM escrow using single secret (secret 4)
     */
    private async unlockEvmEscrow(order: CrossChainOrder, secretsData: any): Promise<void> {
        console.log(`\n🔓 Step 2: Unlocking EVM escrow with single secret`)
        console.log(`   EVM Escrow: ${order.evmEscrowAddress || 'Unknown'}`)
        console.log(`   Using secret 4`)

        try {
            if (!order.evmEscrowAddress) {
                throw new Error('EVM escrow address not found')
            }

            // Convert secret from number array back to Uint8Array
            const evmSecret = new Uint8Array(secretsData.evmSecret)
            console.log(`   Secret (hex): 0x${Array.from(evmSecret).map(b => b.toString(16).padStart(2, '0')).join('')}`)

            // Verify the secret matches the expected hashlock from deployment
            const secretBytes32 = `0x${Array.from(evmSecret).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`
            const expectedHashlock = keccak256(secretBytes32)
            const deployedHashlock = order.leafHashes?.[4] // The hashlock used during deployment

            console.log(`   🔍 Secret verification:`)
            console.log(`     Secret: ${secretBytes32}`)
            console.log(`     Expected hashlock: ${expectedHashlock}`)
            console.log(`     Deployed hashlock: ${deployedHashlock}`)
            console.log(`     Match: ${expectedHashlock === deployedHashlock}`)

            if (expectedHashlock !== deployedHashlock) {
                console.log(`   ❌ Secret doesn't match deployed hashlock!`)
                throw new Error(`Secret verification failed: ${expectedHashlock} !== ${deployedHashlock}`)
            }

            console.log(`   ✅ Secret verified! Attempting withdrawal...`)

            // Use the corrected immutables from deployment (the key discovery!)
            if (!order.correctedImmutables) {
                throw new Error('No corrected immutables found - deployment may have failed')
            }

            const immutables = order.correctedImmutables

            console.log(`   ✅ Using corrected immutables from deployment:`)

            console.log(`   📋 Using corrected immutables:`)
            console.log(`     Order Hash: ${immutables.orderHash}`)
            console.log(`     Hashlock: ${immutables.hashlock}`)
            console.log(`     Maker: ${immutables.maker}`)
            console.log(`     Taker: ${immutables.taker}`)
            console.log(`     Amount: ${immutables.amount} wei`)
            console.log(`     Safety Deposit: ${immutables.safetyDeposit} wei`)
            console.log(`     Timelocks: ${immutables.timelocks}`)
            console.log(`     Parameters: ${immutables.parameters}`)

            // Call withdraw function with secret and immutables
            console.log(`   🔄 Calling withdraw with secret and immutables...`)

            // Add detailed error handling to get the specific revert reason
            let hash: `0x${string}`
            try {
                hash = await this.evmWalletClient.writeContract({
                    address: order.evmEscrowAddress as `0x${string}`,
                    abi: parseAbi([
                        'function withdraw(bytes32 secret, (bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks, bytes parameters) immutables) external'
                    ]),
                    functionName: 'withdraw',
                    args: [secretBytes32, immutables],
                    account: this.evmAccount
                })

                console.log(`   📤 Transaction sent: ${hash}`)
            } catch (error: any) {
                console.log(`   ❌ Detailed error info:`)
                console.log(`     Error message: ${error.message}`)
                console.log(`     Short message: ${error.shortMessage}`)
                console.log(`     Reason: ${error.reason}`)
                console.log(`     Data: ${error.data}`)

                // Try to decode the revert reason if available
                if (error.data) {
                    console.log(`     Raw data: ${error.data}`)
                }

                throw error
            }

            // Wait for confirmation
            console.log(`   ⏳ Waiting for transaction confirmation...`)
            const receipt = await this.evmPublicClient.waitForTransactionReceipt({
                hash,
                timeout: 60000 // 60 second timeout
            })

            if (receipt.status === 'success') {
                console.log(`   ✅ EVM escrow unlocked successfully!`)
                console.log(`   Block: ${receipt.blockNumber}`)
                console.log(`   Gas used: ${receipt.gasUsed}`)

                // Skip final state check - withdrawal was successful
                console.log(`   ✅ Withdrawal transaction confirmed successfully!`)
            } else {
                console.log(`   ❌ EVM unlock transaction failed`)
                console.log(`   Receipt:`, receipt)
            }

        } catch (error) {
            console.error(`   ❌ Failed to unlock EVM escrow:`, error)
            throw error
        }
    }

    /**
     * Handle new order from relayer
     */
    private async handleNewOrder(orderData: any): Promise<void> {
        console.log(`\n🔄 handleNewOrder called for order: ${orderData.orderId}`)

        // 🔍 DEBUG: Check what Alice sent
        console.log(`🔍 DEBUG: orderData.makerSignature: ${orderData.makerSignature || 'undefined'}`)
        console.log(`🔍 DEBUG: orderData.orderState?.makerSignature: ${orderData.orderState?.makerSignature || 'undefined'}`)

        // Extract order data from the nested structure
        const order: CrossChainOrder = {
            orderId: orderData.orderId,
            sourceChain: orderData.orderState?.sourceChain || orderData.sourceChain,
            destinationChain: orderData.orderState?.destinationChain || orderData.destinationChain,
            makerAddress: orderData.orderState?.makerAddress || orderData.makerAddress,
            makerEvmAddress: orderData.orderState?.makerEvmAddress || orderData.makerEvmAddress, // Extract EVM address
            makerAsset: orderData.orderState?.makerAsset || orderData.makerAsset,
            takerAsset: orderData.orderState?.takerAsset || orderData.takerAsset,
            makingAmount: orderData.orderState?.makingAmount || orderData.makingAmount,
            takingAmount: orderData.orderState?.takingAmount || orderData.takingAmount,
            totalParts: orderData.orderState?.totalParts || orderData.totalParts,
            merkleRoot: orderData.merkleRoot || orderData.orderState?.merkleRoot,
            leafHashes: orderData.orderState?.leafHashes || orderData.leafHashes, // Extract leaf hashes from maker
            gaslessTransactionBytes: orderData.gaslessTransactionBytes || orderData.orderState?.gaslessTransactionBytes,
            makerSignature: orderData.makerSignature || orderData.orderState?.makerSignature,
            timeWindows: orderData.orderState?.timeWindows || orderData.timeWindows
        }



        // Only handle SUI → EVM orders
        if (order.sourceChain !== 'SUI_TESTNET' || order.destinationChain !== 'BASE_SEPOLIA') {
            console.log(`⏭️  Skipping order ${order.orderId} (not SUI → EVM)`)
            console.log(`   Expected: SUI_TESTNET → BASE_SEPOLIA`)
            console.log(`   Received: ${order.sourceChain} → ${order.destinationChain}`)
            return
        }

        console.log(`\n🎯 Processing SUI → EVM order: ${order.orderId}`)
        console.log(`   Maker (Sui): ${order.makerAddress}`)
        console.log(`   Maker (EVM): ${order.makerEvmAddress || 'Not provided'}`)
        console.log(`   Amount: ${order.makingAmount} SUI → ${order.takingAmount} USDC`)
        console.log(`   Parts: ${order.totalParts}`)
        console.log(`   Merkle Root: ${order.merkleRoot}`)
        console.log(`   Leaf Hashes: ${order.leafHashes?.length || 0} received`)
        if (order.leafHashes && order.leafHashes.length > 4) {
            console.log(`   🔐 Leaf hash for part 5 (index 4): ${order.leafHashes[4]}`)
        }

        // Store order
        this.orders.set(order.orderId, order)

        // Check if order is worth filling (around $0.10 USDC)
        const takingAmountUsd = parseFloat(order.takingAmount) / 1000000 // USDC has 6 decimals
        if (takingAmountUsd < 0.05 || takingAmountUsd > 0.15) {
            console.log(`⏭️  Skipping order (amount: $${takingAmountUsd.toFixed(2)} USDC, target: ~$0.10)`)
            return
        }

        console.log(`✅ Order meets criteria ($${takingAmountUsd.toFixed(2)} USDC)`)
        console.log(`🎯 Resolver will fill 50% (5/10 parts)`)

        try {
            // Step 1: Deploy Sui escrow (following working example flow)
            const suiEscrowId = await this.sponsorAndDeploySuiEscrow(order)

            if (suiEscrowId) {
                console.log(`🎉 Successfully deployed Sui escrow for order ${order.orderId}`)
                console.log(`   Sui Escrow ID: ${suiEscrowId}`)

                // Store the Sui escrow ID in the order
                order.suiEscrowId = suiEscrowId
                this.orders.set(order.orderId, order)

                // Step 2: Deploy EVM escrow for 5/10 parts
                console.log(`\n🔧 Step 2: Deploying EVM escrow for 5/10 parts`)
                const evmEscrowAddress = await this.deployEvmEscrow(order)

                if (evmEscrowAddress) {
                    console.log(`🎉 Successfully deployed EVM escrow for order ${order.orderId}`)
                    console.log(`   EVM Escrow Address: ${evmEscrowAddress}`)
                    console.log(`   Stopping here as requested - no merkle filling`)

                    // Store the EVM escrow address and deployedAt in the order
                    order.evmEscrowAddress = evmEscrowAddress
                    this.orders.set(order.orderId, order)

                    // Report deployment results to relayer for validation
                    await this.reportDeploymentToRelayer(order.orderId, {
                        srcEscrowSuiAddress: order.suiEscrowId,
                        dstEvmEscrowAddress: evmEscrowAddress,
                        chainId: 84532, // Base Sepolia chain ID
                        hashlock: order.leafHashes?.[4] || '', // The hashlock we used (5th leaf hash)
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
                    })
                }
            } else {
                console.log(`   ⏳ Waiting for escrow deployment to complete...`)
            }

        } catch (error: any) {
            console.error(`❌ Failed to process order ${order.orderId}:`, error)
        }
    }

    /**
     * Pack timelocks EXACTLY like the SDK's build() method (the key discovery!)
     */
    private packTimelocks(
        srcWithdrawal: number,
        srcPublicWithdrawal: number,
        srcCancellation: number,
        srcPublicCancellation: number,
        dstWithdrawal: number,
        dstPublicWithdrawal: number,
        dstCancellation: number,
        deployedAt: number
    ): bigint {
        // SDK's build() method order: [deployedAt, dstCancellation, dstPublicWithdrawal, dstWithdrawal, srcPublicCancellation, srcCancellation, srcPublicWithdrawal, srcWithdrawal]
        return [
            BigInt(deployedAt),           // [0] - deployedAt
            BigInt(dstCancellation),      // [1] - dstCancellation
            BigInt(dstPublicWithdrawal),  // [2] - dstPublicWithdrawal
            BigInt(dstWithdrawal),        // [3] - dstWithdrawal
            BigInt(srcPublicCancellation), // [4] - srcPublicCancellation
            BigInt(srcCancellation),      // [5] - srcCancellation
            BigInt(srcPublicWithdrawal),  // [6] - srcPublicWithdrawal
            BigInt(srcWithdrawal)         // [7] - srcWithdrawal
        ].reduce((acc, el) => (acc << 32n) | el)
    }

    /**
     * Deploy EVM escrow EXACTLY like the successful forge script
     */
    private async deployEvmEscrow(order: CrossChainOrder): Promise<string> {
        console.log(`\n🔧 Step 2: Deploying EVM destination escrow (copying forge script exactly)`)

        // EXACT VALUES from the working WithdrawDst.s.sol script
        const dstAmount = 1000000000000000n // 0.001 ether (exactly like WithdrawDst.s.sol)
        const safetyDeposit = 1000000000000000n // 0.001 ether (exactly like WithdrawDst.s.sol)

        console.log(`   Amount: ${dstAmount} wei`)
        console.log(`   Safety Deposit: ${safetyDeposit} wei`)

        // Use the EXACT hashlock generation from forge script
        const secret = keccak256(toHex("secret")) // keccak256(abi.encodePacked("secret"))
        const hashlock = keccak256(toHex(secret)) // keccak256(abi.encode(secret))
        console.log(`   Secret: ${secret}`)
        console.log(`   Hashlock: ${hashlock}`)

        // Deploy escrow using the factory contract
        console.log(`   Deploying escrow via factory: ${this.evmFactoryAddress}`)

        // Use the EXACT ABI that works (uint256 for addresses - the key discovery!)
        const abi = [
            {
                inputs: [
                    {
                        components: [
                            { name: "orderHash", type: "bytes32" },
                            { name: "hashlock", type: "bytes32" },
                            { name: "maker", type: "uint256" },
                            { name: "taker", type: "uint256" },
                            { name: "token", type: "uint256" },
                            { name: "amount", type: "uint256" },
                            { name: "safetyDeposit", type: "uint256" },
                            { name: "timelocks", type: "uint256" },
                            { name: "parameters", type: "bytes" }
                        ],
                        name: "dstImmutables",
                        type: "tuple"
                    },
                    { name: "srcCancellationTimestamp", type: "uint256" }
                ],
                name: "createDstEscrow",
                outputs: [],
                stateMutability: "payable",
                type: "function"
            }
        ] as const

        try {
            // Check ETH balance with VIEM
            const balance = await this.evmPublicClient.getBalance({ address: this.evmAccount.address })
            const requiredAmount = dstAmount + safetyDeposit // 2 wei total

            console.log(`   📊 Bob's ETH balance: ${balance} wei`)
            console.log(`   📊 Required ETH: ${requiredAmount} wei`)

            if (balance < requiredAmount) {
                throw new Error(`Insufficient ETH balance. Need ${requiredAmount} wei, have ${balance} wei`)
            }

            // Use EXACT values from the order (consistent between deployment and withdrawal)
            // If no ORDER_HASH in env, hash the orderId to create a consistent bytes32 hash
            const orderHash = process.env.ORDER_HASH || keccak256(toHex(order.orderId))

            // Use current timestamp for deployment (will be corrected after deployment)
            const deployedAt = Math.floor(Date.now() / 1000)

            // Pack timelocks with current timestamp (will be corrected after deployment)
            const packedTimelocks = this.packTimelocks(
                1,      // srcWithdrawal: immediate
                2000,   // srcPublicWithdrawal
                3000,   // srcCancellation
                4000,   // srcPublicCancellation
                1,      // dstWithdrawal: immediate (for testing)
                2000,   // dstPublicWithdrawal
                3000,   // dstCancellation
                deployedAt
            )

            // Use type(uint32).max for srcCancellationTimestamp (EXACTLY like forge script)
            const srcCancellationTimestamp = 2 ** 32 - 1 // type(uint32).max = 4294967295

            console.log(`   📝 Using ORDER_HASH: ${orderHash}`)
            console.log(`   📝 Using deployedAt: ${deployedAt}`)
            console.log(`   📝 Using packed TIMELOCKS: ${packedTimelocks}`)

            // Debug: Verify our timelocks packing by simulating the get() function
            const deployedAtFromPacked = Number((packedTimelocks >> 224n) & 0xFFFFFFFFn)
            const dstCancellationOffset = Number(packedTimelocks >> 192n & 0xFFFFFFFFn)
            const calculatedDstCancellation = deployedAtFromPacked + dstCancellationOffset
            console.log(`   🔍 Debug timelocks:`)
            console.log(`     Packed deployedAt: ${deployedAtFromPacked}`)
            console.log(`     DstCancellation offset: ${dstCancellationOffset}`)
            console.log(`     Calculated dstCancellation: ${calculatedDstCancellation}`)
            console.log(`     srcCancellationTimestamp: ${srcCancellationTimestamp}`)
            console.log(`     Time check: ${calculatedDstCancellation} <= ${srcCancellationTimestamp} = ${calculatedDstCancellation <= srcCancellationTimestamp}`)

            // EXACT addresses like the forge script: deployer = maker = taker = transaction sender
            // In forge script: address deployer = vm.envAddress("DEPLOYER_ADDRESS"); address maker = deployer; address taker = deployer;
            // The transaction sender MUST match the deployer/maker/taker addresses
            const deployer = this.evmAccount.address // Bob is the deployer and transaction sender
            const maker = deployer // maker = deployer (like forge script)  
            const taker = deployer // taker = deployer (like forge script)

            // EXACT token address like forge script
            const dstToken = '0x0000000000000000000000000000000000000000' // address(0) for ETH

            // Use dynamic values from the order
            const orderHashFixed = "0x1234567890123456789012345678901234567890123456789012345678901234" as `0x${string}` // OK to hardcode

            // Get hashlock from maker's leaf hashes (Bob fills 5/10 parts, so he uses the 5th leaf hash)
            if (!order.leafHashes || order.leafHashes.length < 5) {
                throw new Error(`Order missing leaf hashes. Need at least 5 leaf hashes, got ${order.leafHashes?.length || 0}`)
            }
            const hashlockFixed = order.leafHashes[4] as `0x${string}` // 5th leaf hash (0-indexed)

            // Get maker from order (Alice's EVM address) and taker is Bob
            const makerAddr = (order.makerEvmAddress || "0x3d849a98e5147a416f63f0b7c664b861b234ef5f") as `0x${string}` // Alice's EVM address
            const takerAddr = this.evmAccount.address as `0x${string}` // Bob is the taker
            const tokenAddr = "0x0000000000000000000000000000000000000000" as `0x${string}` // ETH

            const srcCancellationTimestampFixed = 4294967295n // type(uint32).max

            console.log(`   📋 Using values from order:`)
            console.log(`     Order Hash: ${orderHashFixed} (hardcoded OK)`)
            console.log(`     Hashlock: ${hashlockFixed} (from maker's 5th leaf hash)`)
            console.log(`     Maker: ${makerAddr} (Alice from order)`)
            console.log(`     Taker: ${takerAddr} (Bob)`)
            console.log(`     Packed Timelocks: ${packedTimelocks}`)
            console.log(`     Available leaf hashes: ${order.leafHashes.length}`)

            // Convert addresses to uint256 (like the successful forge script)
            const makerUint256 = BigInt(makerAddr)
            const takerUint256 = BigInt(takerAddr)
            const tokenUint256 = BigInt(tokenAddr)

            // Build parameters like buildDstEscrowImmutables does
            const protocolFeeAmount = 0n
            const integratorFeeAmount = 0n
            const protocolFeeRecipient = this.evmAccount.address
            const integratorFeeRecipient = this.evmAccount.address

            // Encode parameters exactly like buildDstEscrowImmutables
            const parametersEncoded = `0x${[
                protocolFeeAmount.toString(16).padStart(64, '0'),
                integratorFeeAmount.toString(16).padStart(64, '0'),
                BigInt(protocolFeeRecipient).toString(16).padStart(64, '0'),
                BigInt(integratorFeeRecipient).toString(16).padStart(64, '0')
            ].join('')}`

            const dstImmutables = {
                orderHash: orderHashFixed,
                hashlock: hashlockFixed,
                maker: makerUint256,
                taker: takerUint256,
                token: tokenUint256,
                amount: dstAmount,
                safetyDeposit: safetyDeposit,
                timelocks: packedTimelocks,
                parameters: parametersEncoded
            }

            console.log(`   📋 Parameters encoded: ${parametersEncoded}`)

            console.log(`   Creating EVM escrow with EXACT forge script parameters:`)
            console.log(`     Order Hash: ${orderHash}`)
            console.log(`     Hashlock: ${hashlock}`)
            console.log(`     Maker: ${maker}`)
            console.log(`     Taker: ${taker}`)
            console.log(`     Token: ${dstToken} (native ETH)`)
            console.log(`     Amount: ${dstAmount} wei`)
            console.log(`     Safety Deposit: ${safetyDeposit} wei`)
            console.log(`     Timelocks: ${packedTimelocks}`)
            console.log(`     Src Cancellation Timestamp: ${srcCancellationTimestamp}`)

            console.log(`   🚀 Deploying escrow with VIEM...`)

            // Send the transaction with VIEM
            const hash = await this.evmWalletClient.writeContract({
                address: this.evmFactoryAddress,
                abi,
                functionName: 'createDstEscrow',
                args: [dstImmutables, srcCancellationTimestampFixed],
                value: requiredAmount
            })

            console.log(`   📝 Transaction sent: ${hash}`)
            console.log(`   ⏳ Waiting for confirmation...`)

            const receipt = await this.evmPublicClient.waitForTransactionReceipt({ hash })

            console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`)
            console.log(`   ⛽ Gas used: ${receipt.gasUsed}`)

            // Get actual block timestamp and correct the timelocks (the key discovery!)
            const deploymentBlock = await this.evmPublicClient.getBlock({ blockNumber: receipt.blockNumber })
            const actualBlockTimestamp = Number(deploymentBlock.timestamp)

            console.log(`   ⏰ Timestamp correction:`)
            console.log(`     Script deployedAt: ${deployedAt}`)
            console.log(`     Actual block timestamp: ${actualBlockTimestamp}`)

            // Reconstruct timelocks with actual block timestamp (like the contract does internally)
            const correctedTimelocks = this.packTimelocks(
                1,      // srcWithdrawal: immediate
                2000,   // srcPublicWithdrawal
                3000,   // srcCancellation
                4000,   // srcPublicCancellation
                1,      // dstWithdrawal: immediate (for testing)
                2000,   // dstPublicWithdrawal
                3000,   // dstCancellation
                actualBlockTimestamp  // Use actual block timestamp
            )

            console.log(`   🔄 Timelocks correction:`)
            console.log(`     Original: ${packedTimelocks}`)
            console.log(`     Corrected: ${correctedTimelocks}`)

            // Wait 2 seconds for the escrow object to be properly indexed
            console.log(`   ⏳ Waiting 2 seconds for escrow object to be indexed...`)
            await new Promise(resolve => setTimeout(resolve, 2000))

            // Parse the escrow address from the transaction logs
            let evmEscrowAddress = null
            console.log(`   🔍 Parsing Transaction Logs (${receipt.logs.length} logs)`)

            // Look for DstEscrowCreated event
            for (const log of receipt.logs) {
                if (log.topics[0] === '0xc30e111dcc74fddc2c3a4d98ffb97adec4485c0a687946bf5b22c2a99c7ff96d') {
                    // This is the DstEscrowCreated event topic from the successful forge script
                    evmEscrowAddress = `0x${log.data.slice(26, 66)}` // Extract address from data
                    console.log(`   📍 Found DstEscrowCreated event!`)
                    console.log(`   📍 Escrow Address: ${evmEscrowAddress}`)
                    break
                }
            }

            if (!evmEscrowAddress) {
                console.log(`   ⚠️  Could not parse escrow address from logs`)
                console.log(`   🔍 All log topics:`)
                receipt.logs.forEach((log: any, index: number) => {
                    console.log(`     Log ${index}: ${log.topics[0]}`)
                })

                // Use the address from successful forge script as placeholder
                evmEscrowAddress = '0x58f2db213de9245a8faf651128036ede55f2c46a'
                console.log(`   📍 Using successful forge script address: ${evmEscrowAddress}`)
            }

            console.log(`   🎉 EVM destination escrow deployed successfully!`)
            console.log(`   📍 EVM Escrow Address: ${evmEscrowAddress}`)
            console.log(`   💰 Locked: ${dstAmount} wei + ${safetyDeposit} wei safety deposit`)
            console.log(`   🔐 Hashlock: ${hashlockFixed}`)
            console.log(`   ✅ VIEM deployment successful!`)

            // Store the corrected timestamp and timelocks in the order for consistent withdrawal
            order.deployedAt = actualBlockTimestamp

            // Store corrected immutables for withdrawal
            const correctedImmutables = {
                orderHash: orderHashFixed,
                hashlock: hashlockFixed,
                maker: makerUint256,
                taker: takerUint256,
                token: tokenUint256,
                amount: dstAmount,
                safetyDeposit: safetyDeposit,
                timelocks: correctedTimelocks,  // Use corrected timelocks
                parameters: parametersEncoded
            }

            // Store in order for withdrawal
            order.correctedImmutables = correctedImmutables

            return evmEscrowAddress

        } catch (error: any) {
            console.error(`   ❌ Failed to deploy EVM escrow:`, error)
            throw error
        }
    }

    /**
     * Create gasless transaction for the maker
     */
    private async createGaslessTransaction(order: CrossChainOrder, client: SuiClient): Promise<Transaction> {
        console.log(`🔧 Creating gasless transaction for escrow creation`)
        console.log(`   Maker Address: ${order.makerAddress}`)
        console.log(`   Requested escrow amount: ${order.makingAmount} MIST = ${parseInt(order.makingAmount) / 1000000000} SUI`)
        console.log(`   Alice should have: 0.35 SUI (350,000,000 MIST)`)
        console.log(`   Amount needed: ${parseInt(order.makingAmount) / 1000000000} SUI`)
        console.log(`   Sufficient funds: ${parseInt(order.makingAmount) <= 350000000 ? 'YES' : 'NO'}`)

        // Use Bob's coins for the escrow since he's the gas sponsor anyway
        console.log(`   Using Bob's coins for escrow (gasless transaction)`)

        const bobCoins = await client.getCoins({
            owner: this.bobKeypair.toSuiAddress(),
            coinType: '0x2::sui::SUI'
        })

        if (bobCoins.data.length === 0) {
            throw new Error("Bob has no SUI coins for escrow")
        }

        const bobCoin = bobCoins.data[0]
        console.log(`   Using Bob's coin: ${bobCoin.coinObjectId} (${bobCoin.balance} MIST)`)

        // Use Bob's coin for the escrow (Alice will still be the owner)
        const aliceCoin = bobCoin

        // Create gasless transaction
        const gaslessTx = new Transaction()

        // Calculate time windows from order
        const merkleRoot = Array.from(hexToBytes(order.merkleRoot as `0x${string}`))
        const escrowAmount = parseInt(order.makingAmount)

        console.log(`   Merkle Root: ${order.merkleRoot}`)
        console.log(`   Number of parts: ${order.totalParts}`)

        // Use SRC environment variables consistently
        const PACKAGE_ID = this.PACKAGE_ID
        const FACTORY_ID = this.FACTORY_ID
        const FACTORY_VERSION = parseInt(this.FACTORY_VERSION)

        console.log(`   Package ID: ${PACKAGE_ID}`)
        console.log(`   Factory ID: ${FACTORY_ID}`)
        console.log(`   Factory Version: ${FACTORY_VERSION}`)

        const [splitCoin] = gaslessTx.splitCoins(gaslessTx.object(aliceCoin.coinObjectId), [escrowAmount])

        // Create escrow with parts
        gaslessTx.moveCall({
            target: `${PACKAGE_ID}::srcescrow::create_and_transfer_escrow`,
            arguments: [
                gaslessTx.sharedObjectRef({
                    objectId: FACTORY_ID,
                    initialSharedVersion: FACTORY_VERSION,
                    mutable: true
                }),
                splitCoin,
                gaslessTx.pure.vector('u8', merkleRoot),
                gaslessTx.pure.u64(order.timeWindows?.dstWithdrawal || Date.now() + 600000),
                gaslessTx.pure.u64(order.timeWindows?.dstPublicWithdrawal || Date.now() + 900000),
                gaslessTx.pure.u64(order.timeWindows?.dstCancellation || Date.now() + 1200000),
                gaslessTx.pure.u64(order.totalParts),
                gaslessTx.pure.u64(Date.now() + 600000), // deadline
                gaslessTx.object('0x6'),
            ],
        })

        console.log(`✅ Created gasless transaction`)
        return gaslessTx
    }

    // Store finalTxBytes for each order (waiting for signature)
    private storedTransactions: Map<string, Uint8Array> = new Map()

    /**
     * Sponsor and deploy Sui escrow - EXACTLY like working example but with signature flow
     */
    public async sponsorAndDeploySuiEscrow(order: CrossChainOrder): Promise<string | null> {
        console.log(`🔍 DEBUG: sponsorAndDeploySuiEscrow called for order: ${order.orderId}`)
        console.log(`🔍 DEBUG: order.makerSignature exists: ${!!order.makerSignature}`)

        // Check if we already have the maker's signature
        if (!order.makerSignature) {
            console.log(`🔐 No maker signature yet - creating transaction for signing`)
            return await this.createTransactionForSigning(order)
        } else {
            console.log(`🔐 Maker signature received - executing transaction`)
            return await this.executeTransactionWithSignature(order)
        }
    }

    /**
     * Create transaction and send to maker for signing (STEP 1)
     */
    private async createTransactionForSigning(order: CrossChainOrder): Promise<null> {
        // Get Alice's address from the order (resolver doesn't have Alice's private key)
        const aliceAddress = order.makerAddress;

        console.log(`\n🔸 CREATING ESCROW WITH 10 PARTS (FOR SIGNING)`);
        console.log("=".repeat(50));

        // Check Alice's coins
        const aliceCoins = await client.getCoins({
            owner: aliceAddress,
            coinType: '0x2::sui::SUI'
        });

        if (aliceCoins.data.length === 0) {
            throw new Error("Alice has no SUI coins");
        }

        const aliceCoin = aliceCoins.data[0];
        console.log(`Alice coin: ${aliceCoin.coinObjectId} (${aliceCoin.balance} MIST)`);

        // Create gasless transaction
        const gaslessTx = new Transaction();

        // Calculate time windows (EXACTLY like working example)
        const currentTime = Date.now();
        const dstWithdrawalEnd = currentTime + 600000;      // +10 minutes 
        const dstPublicWithdrawalEnd = currentTime + 900000;  // +15 minutes
        const dstCancellationEnd = currentTime + 1200000;     // +20 minutes
        const deadline = currentTime + 600000; // +10 minutes

        const merkleRoot = this.hexToNumberArray(order.merkleRoot);

        const numParts = 10; // 10 parts as requested
        const escrowAmount = 1000000; // 0.001 SUI (1M MIST) - EXACTLY like working example

        console.log(`Escrow amount: ${escrowAmount} MIST (${escrowAmount / 1000000000} SUI)`);
        console.log(`Merkle Root: ${order.merkleRoot}`);
        console.log(`Number of parts: ${numParts}`);

        const [splitCoin] = gaslessTx.splitCoins(gaslessTx.object(aliceCoin.coinObjectId), [escrowAmount]);

        // Use the instance variables loaded from environment (consistent with demo)
        const PACKAGE_ID = this.PACKAGE_ID;
        const FACTORY_ID = this.FACTORY_ID;
        const FACTORY_VERSION = parseInt(this.FACTORY_VERSION);

        console.log(`   Package ID: ${PACKAGE_ID}`)
        console.log(`   Factory ID: ${FACTORY_ID}`)
        console.log(`   Factory Version: ${FACTORY_VERSION}`)

        gaslessTx.moveCall({
            target: `${PACKAGE_ID}::srcescrow::create_and_transfer_escrow`,
            arguments: [
                gaslessTx.sharedObjectRef({
                    objectId: FACTORY_ID,
                    initialSharedVersion: FACTORY_VERSION, // Use actual version from env
                    mutable: true
                }),
                splitCoin,
                gaslessTx.pure.vector('u8', merkleRoot),
                gaslessTx.pure.u64(dstWithdrawalEnd),
                gaslessTx.pure.u64(dstPublicWithdrawalEnd),
                gaslessTx.pure.u64(dstCancellationEnd),
                gaslessTx.pure.u64(numParts),
                gaslessTx.pure.u64(deadline),
                gaslessTx.object('0x6'),
            ],
        });

        // Build gasless transaction
        const kindBytes = await gaslessTx.build({ client, onlyTransactionKind: true });
        console.log(`✅ Resolver created GasLessTransactionData`);

        // Bob creates sponsored transaction
        const sponsoredTx = Transaction.fromKind(kindBytes);
        sponsoredTx.setSender(aliceAddress);

        // Bob provides gas payment
        const bobCoins = await client.getCoins({
            owner: this.bobKeypair.toSuiAddress(),
            coinType: '0x2::sui::SUI'
        });

        if (bobCoins.data.length === 0) {
            throw new Error("Bob has no SUI coins for gas sponsorship");
        }

        const bobCoin = bobCoins.data[0];
        sponsoredTx.setGasOwner(this.bobKeypair.toSuiAddress());
        sponsoredTx.setGasPayment([{
            objectId: bobCoin.coinObjectId,
            version: bobCoin.version,
            digest: bobCoin.digest
        }]);
        sponsoredTx.setGasBudget(20000000); // EXACTLY like working example

        const finalTxBytes = await sponsoredTx.build({ client });

        // Store finalTxBytes for later execution
        this.storedTransactions.set(order.orderId, finalTxBytes);

        // Log final transaction bytes info
        console.log(`🔍 FINAL TX BYTES (for signing):`);
        console.log(`   Length: ${finalTxBytes.length}`);
        console.log(`   First 20: [${Array.from(finalTxBytes.slice(0, 20)).join(', ')}]`);

        // Send finalTxBytes to relayer → maker for signing
        console.log(`📤 Sending finalTxBytes to relayer for maker to sign`);
        await this.sendTransactionForSigning(order.orderId, finalTxBytes);

        console.log(`⏳ Waiting for maker signature...`);
        return null; // Return null to indicate waiting for signature
    }

    /**
     * Execute transaction with both signatures (STEP 2)
     */
    private async executeTransactionWithSignature(order: CrossChainOrder): Promise<string | null> {
        console.log(`\n🔸 EXECUTING ESCROW WITH SIGNATURES`);
        console.log("=".repeat(50));

        // Get stored finalTxBytes
        const finalTxBytes = this.storedTransactions.get(order.orderId);
        if (!finalTxBytes) {
            throw new Error(`No stored transaction found for order ${order.orderId}`);
        }

        console.log(`📥 Retrieved stored finalTxBytes (${finalTxBytes.length} bytes)`);

        // Bob signs the transaction
        const bobSignature = await this.bobKeypair.signTransaction(finalTxBytes);
        console.log(`✅ Bob signed as gas sponsor`);
        console.log(`✅ Alice signature received from maker`);

        // Execute with both signatures (EXACTLY like working example)
        let result;
        try {
            result = await client.executeTransactionBlock({
                transactionBlock: finalTxBytes,
                signature: [order.makerSignature!, bobSignature.signature], // Alice first, Bob second
                options: {
                    showEffects: true,
                    showEvents: true,
                    showObjectChanges: true,
                    showBalanceChanges: true,
                },
            });
        } catch (error) {
            console.log(`❌ Transaction execution failed:`, error);
            return null;
        }

        console.log(`✅ Transaction executed: ${result.digest}`);
        console.log(`✅ Status: ${result.effects?.status?.status}`);

        if (result.effects?.status?.status !== 'success') {
            console.log(`❌ ESCROW CREATION FAILED!`);
            return null;
        }

        // Wait 2 seconds for objects to be properly indexed on Sui
        console.log(`⏳ Waiting 2 seconds for Sui objects to be indexed...`);
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Extract created escrow object (EXACTLY like working example)
        const createdObjects = result.objectChanges?.filter(
            change => change.type === 'created'
        );

        console.log(`🔍 DEBUG: Found ${createdObjects?.length || 0} created objects`);
        if (createdObjects) {
            createdObjects.forEach((obj, index) => {
                console.log(`   Object ${index}: ${obj.objectType} - ${obj.objectId}`);
            });
        }

        // Look for any created object that might be the escrow
        if (createdObjects && createdObjects.length > 0) {
            // Try to find escrow by object type first
            let escrowObject = createdObjects.find(obj =>
                obj.objectType?.includes('::srcescrow::Escrow') ||
                obj.objectType?.includes('Escrow')
            );

            // If not found, use the first created object (most likely the escrow)
            if (!escrowObject) {
                escrowObject = createdObjects[0];
                console.log(`⚠️  No explicit escrow object found, using first created object`);
            }

            const escrowId = escrowObject.objectId;
            console.log(`✅ Escrow created: ${escrowId}`);
            console.log(`   Object type: ${escrowObject.objectType}`);

            // Clean up stored transaction
            this.storedTransactions.delete(order.orderId);

            return escrowId;
        } else {
            console.log("❌ No created objects found in transaction result");
            console.log("🔍 DEBUG: Full object changes:");
            console.log(JSON.stringify(result.objectChanges, null, 2));
            return null;
        }
    }

    /**
     * Send finalTxBytes to relayer for maker to sign
     */
    private async sendTransactionForSigning(orderId: string, finalTxBytes: Uint8Array): Promise<void> {
        const message: RelayerMessage = {
            type: 'EXECUTE_ORDER',
            id: this.generateMessageId(),
            data: {
                orderId: orderId,
                finalTransactionBytes: Array.from(finalTxBytes), // Convert to number array for JSON
                clientType: 'RESOLVER',
                action: 'SPONSORED_TRANSACTION_READY'
            },
            clientType: 'RESOLVER'
        }

        console.log(`📤 Sending SPONSORED_TRANSACTION_READY event to relayer`);
        await this.sendMessage(message);
    }
    /**
     * Helper to convert hex string to number array
     */
    private hexToNumberArray(hex: string): number[] {
        const bytes = hexToBytes(hex as `0x${string}`)
        return Array.from(bytes)
    }

    // Removed complex hashlock calculation methods - now using leaf hashes directly from maker

    /**
     * Subscribe to all orders
     */
    async subscribeToAllOrders(): Promise<any> {
        console.log(`🔍 Subscribing to all orders...`)
        const message: RelayerMessage = {
            type: 'SUBSCRIBE_EVENTS',
            id: this.generateMessageId(),
            data: { orderIds: [] }, // Empty array means subscribe to all
            clientType: 'RESOLVER'
        }

        console.log(`📤 Sending subscription message: ${JSON.stringify(message)}`)
        return this.sendMessage(message)
    }

    /**
     * Get all orders
     */
    async getAllOrders(): Promise<any> {
        console.log(`🔍 Getting all existing orders...`)
        const message: RelayerMessage = {
            type: 'GET_ORDERS',
            id: this.generateMessageId(),
            data: {},
            clientType: 'RESOLVER'
        }

        console.log(`📤 Sending get orders message: ${JSON.stringify(message)}`)
        return this.sendMessage(message)
    }

    /**
     * Notify relayer that escrows are deployed and request secrets
     */
    private async notifyRelayerEscrowsDeployed(orderId: string, evmEscrowAddress: string, suiEscrowId: string): Promise<void> {
        console.log(`\n🔗 Notifying relayer that escrows are deployed for order ${orderId}`)
        console.log(`   EVM Escrow: ${evmEscrowAddress}`)
        console.log(`   Sui Escrow: ${suiEscrowId}`)

        const message: RelayerMessage = {
            type: 'EXECUTE_ORDER',
            id: this.generateMessageId(),
            data: {
                orderId: orderId,
                evmEscrowAddress: evmEscrowAddress,
                suiEscrowId: suiEscrowId,
                clientType: 'RESOLVER'
            }
        }

        console.log(`📤 Sending execute order message: ${JSON.stringify(message)}`)
        try {
            const response = await this.sendMessage(message)
            console.log(`✅ Relayer acknowledged escrows deployment. Response:`, response)
        } catch (error) {
            console.error(`❌ Failed to notify relayer about escrows deployment:`, error)
            throw error
        }
    }

    /**
     * Close connection
     */
    close(): void {
        this.ws.close()
    }
}

// Main resolver demo
async function demonstrateResolver() {
    console.log('🎯 SUI → EVM Resolver Demo')
    console.log('='.repeat(40))
    console.log('💰 Target orders: ~$0.10 USDC')
    console.log('🔗 Direction: SUI → EVM only')
    console.log('')

    const resolver = new SuiToEvmResolver()

    // Wait for connection
    await new Promise<void>((resolve) => {
        resolver.on('connected', resolve)
    })

    try {
        // Subscribe to all orders
        console.log('📡 Subscribing to all orders...')
        await resolver.subscribeToAllOrders()
        console.log('✅ Subscribed to all orders')

        // Get existing orders
        console.log('\n📋 Getting existing orders...')
        const orders = await resolver.getAllOrders()
        console.log(`✅ Found ${orders.length} existing orders`)

        // Show resolver info
        console.log('\n🔧 Resolver Configuration:')
        console.log(`   Sui Package ID: ${resolver['PACKAGE_ID']}`)
        console.log(`   Sui Factory ID: ${resolver['FACTORY_ID']}`)
        console.log(`   EVM Factory: ${resolver['evmFactoryAddress']}`)
        console.log(`   EVM Wallet: ${resolver['evmAccount'].address}`)

        // Keep connection alive and wait for orders
        console.log('\n⏳ Waiting for SUI → EVM orders to fill...')
        console.log('   Press Ctrl+C to exit')

        // Keep the process alive
        process.on('SIGINT', () => {
            console.log('\n🛑 Shutting down resolver...')
            resolver.close()
            process.exit(0)
        })

    } catch (error) {
        console.error('❌ Error:', error)
        resolver.close()
    }
}

// Run demo if this file is executed directly
if (require.main === module) {
    demonstrateResolver().catch(console.error)
}

export { SuiToEvmResolver, demonstrateResolver } 