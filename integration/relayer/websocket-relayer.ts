#!/usr/bin/env ts-node

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import * as dotenv from 'dotenv'

// Load environment variables
dotenv.config()

const { Server: WebSocketServer } = require('ws')

// Types for WebSocket communication
export interface RelayerMessage {
    type: 'CREATE_ORDER' | 'EXECUTE_ORDER' | 'GET_ORDERS' | 'GET_ORDER_STATUS' | 'SUBSCRIBE_EVENTS' | 'REPORT_DEPLOYMENT' | 'PROVIDE_SECRETS' | 'AUTHORIZED_SECRETS'
    id: string
    data: any
    clientType?: 'MAKER' | 'RESOLVER' | 'UNKNOWN' // Optional client type identification
}

export interface RelayerResponse {
    type: 'ORDER_CREATED' | 'ORDER_EXECUTED' | 'ORDER_STATUS' | 'ORDERS_LIST' | 'EVENT' | 'ERROR'
    id: string
    success: boolean
    data?: any
    error?: string

}

export interface CreateOrderRequest {
    sourceChain: any
    destinationChain: any
    makerAddress: string
    makerEvmAddress?: string // Add Alice's EVM address
    makerAsset: string
    takerAsset: string
    makingAmount: string
    takingAmount: string
    totalParts: number
    merkleRoot?: string
    leafHashes?: string[] // Add leaf hashes from maker
    gaslessTransactionBytes?: number[] // Changed from signedTransactionBytes
    timeWindows: {
        srcWithdrawal: number
        srcPublicWithdrawal: number
        srcCancellation: number
        dstWithdrawal: number
        dstPublicWithdrawal: number
        dstCancellation: number
    }
}

export interface ExecuteOrderRequest {
    orderId: string
    takerAddress: string
    partsToFill: number[]
    evmEscrowAddress?: string
    suiEscrowId?: string
    clientType?: string
    type?: string // Added for SPONSORED_TRANSACTION_READY
    action?: string // Added for SPONSORED_TRANSACTION_READY action
    finalTransactionBytes?: number[] // Added for SPONSORED_TRANSACTION_READY
    makerSignature?: string // Added for SPONSORED_TRANSACTION_READY
}

export class WebSocketRelayer extends EventEmitter {
    private wss: any
    private bridge: any
    private clients: Map<string, WebSocket> = new Map()
    private clientTypes: Map<string, 'MAKER' | 'RESOLVER' | 'UNKNOWN'> = new Map() // clientId -> clientType
    private orderSubscriptions: Map<string, Set<string>> = new Map() // orderId -> clientIds
    private clientSubscriptions: Map<string, Set<string>> = new Map() // clientId -> orderIds
    private globalSubscribers: Set<string> = new Set() // clientIds that want all orders
    private orders: Map<string, any> = new Map() // orderId -> orderData

    constructor(port: number = 8080) {
        super()

        // Create WebSocket server
        this.wss = new WebSocketServer({ port })

        // Create bridge instance (mock for now)
        this.bridge = {
            start: async () => console.log('Bridge started'),
            stop: async () => console.log('Bridge stopped'),
            createCrossChainOrder: async (sourceChain: string, destinationChain: string, makerAddress: string, makerAsset: string, takerAsset: string, makingAmount: string, takingAmount: string, totalParts: number, timeWindows: any, gaslessTransactionBytes?: number[], makerEvmAddress?: string, leafHashes?: string[], merkleRoot?: string) => {
                console.log('Creating cross-chain order:', { sourceChain, destinationChain, makerAddress, makerEvmAddress, makerAsset, takerAsset, makingAmount, takingAmount, totalParts })
                console.log('Leaf hashes received:', leafHashes?.length || 0)

                const orderId = `order_${Date.now()}`

                // Store the order data
                this.orders.set(orderId, {
                    orderId,
                    sourceChain,
                    destinationChain,
                    makerAddress,
                    makerEvmAddress: makerEvmAddress || null, // Store EVM address
                    makerAsset,
                    takerAsset,
                    makingAmount,
                    takingAmount,
                    totalParts,
                    timeWindows,
                    gaslessTransactionBytes, // Store the gasless transaction bytes
                    leafHashes: leafHashes || [], // Store leaf hashes
                    merkleRoot: merkleRoot || null, // Store merkle root
                    status: 'PENDING'
                })

                return {
                    salt: { toString: () => orderId },
                    getOrderSummary: () => ({ orderId })
                }
            },
            executeOrder: async (...args: any[]) => {
                console.log('Executing order:', args)
                return true
            },
            getOrderState: (orderId: string) => {
                const order = this.orders.get(orderId)
                if (!order) {
                    return null
                }
                return {
                    orderId: order.orderId,
                    status: order.status,
                    sourceChain: order.sourceChain,
                    destinationChain: order.destinationChain,
                    makerAddress: order.makerAddress,
                    makerEvmAddress: order.makerEvmAddress, // Add EVM address
                    makerAsset: order.makerAsset,
                    takerAsset: order.takerAsset,
                    makingAmount: order.makingAmount,
                    takingAmount: order.takingAmount,
                    totalParts: order.totalParts,
                    timeWindows: order.timeWindows,
                    gaslessTransactionBytes: order.gaslessTransactionBytes, // Add this field
                    leafHashes: order.leafHashes, // Add leaf hashes
                    merkleRoot: order.merkleRoot // Add merkle root
                }
            },
            getAllOrderStates: () => {
                return Array.from(this.orders.values())
            },
            addEventListener: (event: string, callback: Function) => {
                console.log('Event listener added:', event)
            }
        }

        this.setupWebSocketServer()
        this.setupBridgeEventHandling()
    }

    /**
     * Start the relayer
     */
    async start(): Promise<void> {
        console.log('🚀 Starting WebSocket Relayer...')

        // Start the bridge
        await this.bridge.start()

        console.log(`✅ WebSocket Relayer started on port ${this.wss.options.port}`)
        console.log(`📡 Bridge service started`)
        console.log(`🔗 Clients can connect to: ws://localhost:${this.wss.options.port}`)
        console.log('')
    }

    /**
     * Stop the relayer
     */
    async stop(): Promise<void> {
        console.log('🛑 Stopping WebSocket Relayer...')

        // Stop the bridge
        await this.bridge.stop()

        // Close all client connections
        this.clients.forEach(client => {
            client.close()
        })
        this.clients.clear()

        // Close WebSocket server
        this.wss.close()

        console.log('✅ WebSocket Relayer stopped')
    }

    /**
     * Setup WebSocket server
     */
    private setupWebSocketServer(): void {
        this.wss.on('connection', (ws: WebSocket, req: any) => {
            const clientId = this.generateClientId()
            const clientIp = req.socket.remoteAddress || 'unknown'

            console.log(`🔌 New client connected: ${clientId} (${clientIp})`)

            // Store client
            this.clients.set(clientId, ws)

            // Send welcome message
            this.sendToClient(clientId, {
                type: 'EVENT',
                id: 'welcome',
                success: true,
                data: {
                    message: 'Connected to Sui ↔ EVM Cross-Chain Relayer',
                    clientId,
                    timestamp: Date.now(),
                    supportedOperations: [
                        'CREATE_ORDER',
                        'EXECUTE_ORDER',
                        'GET_ORDERS',
                        'GET_ORDER_STATUS',
                        'SUBSCRIBE_EVENTS'
                    ]
                }
            })

            // Handle incoming messages
            ws.on('message', (data: Buffer | string) => {
                try {
                    const message: RelayerMessage = JSON.parse(data.toString())
                    this.handleMessage(clientId, message)
                } catch (error) {
                    console.error(`❌ Error parsing message from ${clientId}:`, error)
                    this.sendToClient(clientId, {
                        type: 'ERROR',
                        id: 'parse_error',
                        success: false,
                        data: null,
                        error: 'Invalid JSON message'
                    })
                }
            })

            // Handle client disconnect
            ws.on('close', () => {
                const clientType = this.clientTypes.get(clientId) || 'UNKNOWN'
                console.log(`🔌 ${clientType} disconnected: ${clientId}`)
                this.handleClientDisconnect(clientId)
            })

            // Handle errors
            ws.on('error', (error: Error) => {
                console.error(`❌ WebSocket error for ${clientId}:`, error)
                this.handleClientDisconnect(clientId)
            })
        })

        console.log(`🌐 WebSocket server listening on port ${this.wss.options.port}`)
    }

    /**
     * Setup bridge event handling
     */
    private setupBridgeEventHandling(): void {
        this.bridge.addEventListener('relayer-bridge', (event: any) => {
            console.log(`📡 Bridge Event: ${event.type} for order ${event.orderId}`)

            // Notify subscribed clients
            this.notifyOrderSubscribers(event.orderId, {
                type: 'EVENT',
                id: 'bridge_event',
                success: true,
                data: {
                    bridgeEvent: event,
                    timestamp: Date.now()
                }
            })
        })
    }

    /**
     * Handle incoming messages from clients
     */
    private async handleMessage(clientId: string, message: RelayerMessage): Promise<void> {
        // Detect client type based on message type
        if (message.clientType) {
            this.clientTypes.set(clientId, message.clientType)
        } else if (message.type === 'CREATE_ORDER') {
            this.clientTypes.set(clientId, 'MAKER')
        } else if (message.type === 'EXECUTE_ORDER') {
            this.clientTypes.set(clientId, 'RESOLVER')
        }

        const clientType = this.clientTypes.get(clientId) || 'UNKNOWN'
        console.log(`📨 Message from ${clientType} ${clientId}: ${message.type}`)

        try {
            switch (message.type) {
                case 'CREATE_ORDER':
                    await this.handleCreateOrder(clientId, message)
                    break

                case 'EXECUTE_ORDER':
                    await this.handleExecuteOrder(clientId, message)
                    break

                case 'GET_ORDERS':
                    await this.handleGetOrders(clientId, message)
                    break

                case 'GET_ORDER_STATUS':
                    await this.handleGetOrderStatus(clientId, message)
                    break

                case 'SUBSCRIBE_EVENTS':
                    await this.handleSubscribeEvents(clientId, message)
                    break

                case 'REPORT_DEPLOYMENT':
                    await this.handleReportDeployment(clientId, message)
                    break

                case 'PROVIDE_SECRETS':
                    await this.handleProvideSecrets(clientId, message)
                    break

                default:
                    console.warn(`⚠️ Unknown message type: ${message.type}`)
                    this.sendToClient(clientId, {
                        type: 'ERROR',
                        id: message.id,
                        success: false,
                        data: null,
                        error: `Unknown message type: ${message.type}`
                    })
            }
        } catch (error) {
            console.error(`❌ Error handling message from ${clientType} ${clientId}:`, error)
            this.sendToClient(clientId, {
                type: 'ERROR',
                id: message.id,
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Unknown error'
            })
        }
    }

    /**
     * Handle create order request
     */
    private async handleCreateOrder(clientId: string, message: RelayerMessage): Promise<void> {
        const request: CreateOrderRequest = message.data
        const clientType = this.clientTypes.get(clientId) || 'UNKNOWN'

        console.log(`📝 ${clientType} creating order: ${request.sourceChain} → ${request.destinationChain}`)
        console.log(`   Maker (Sui): ${request.makerAddress}`)
        console.log(`   Maker (EVM): ${request.makerEvmAddress || 'Not provided'}`)
        console.log(`   Assets: ${request.makerAsset} → ${request.takerAsset}`)
        console.log(`   Amounts: ${request.makingAmount} → ${request.takingAmount}`)
        console.log(`   Parts: ${request.totalParts}`)
        console.log(`   Leaf Hashes: ${request.leafHashes?.length || 0} received`)
        if (request.leafHashes && request.leafHashes.length > 4) {
            console.log(`   🔐 Sample leaf hash (index 4): ${request.leafHashes[4]}`)
        }

        if (request.gaslessTransactionBytes) {
            console.log(`📥 Received gasless transaction (${request.gaslessTransactionBytes.length} bytes)`)
        }

        try {
            const order = await this.bridge.createCrossChainOrder(
                request.sourceChain as any,
                request.destinationChain as any,
                request.makerAddress,
                request.makerAsset,
                request.takerAsset,
                request.makingAmount,
                request.takingAmount,
                request.totalParts,
                request.timeWindows,
                request.gaslessTransactionBytes,
                request.makerEvmAddress, // Pass EVM address to bridge
                request.leafHashes, // Pass leaf hashes to bridge
                request.merkleRoot // Pass merkle root to bridge
            )

            const orderState = this.bridge.getOrderState(order.salt.toString())

            this.sendToClient(clientId, {
                type: 'ORDER_CREATED',
                id: message.id,
                success: true,
                data: {
                    orderId: order.salt.toString(),
                    order: order.getOrderSummary(),
                    orderState,
                    timestamp: Date.now()
                }
            })

            console.log(`✅ Order created successfully: ${order.salt.toString()}`)

            // Notify global subscribers about the new order
            this.globalSubscribers.forEach(globalClientId => {
                if (globalClientId !== clientId) { // Don't notify the creator
                    console.log(`🌍 Notifying global subscriber ${globalClientId} about new order: ${order.salt.toString()}`)

                    // Get the complete order data
                    const orderData = this.bridge.getOrderState(order.salt.toString())
                    console.log(`🔍 DEBUG: orderData from getOrderState has ${orderData.leafHashes?.length || 0} leaf hashes`)

                    this.sendToClient(globalClientId, {
                        type: 'ORDER_CREATED',
                        id: 'global_notification',
                        success: true,
                        data: {
                            orderId: order.salt.toString(),
                            sourceChain: orderData.sourceChain,
                            destinationChain: orderData.destinationChain,
                            makerAddress: orderData.makerAddress,
                            makerEvmAddress: orderData.makerEvmAddress, // Include EVM address
                            makerAsset: orderData.makerAsset,
                            takerAsset: orderData.takerAsset,
                            makingAmount: orderData.makingAmount,
                            takingAmount: orderData.takingAmount,
                            totalParts: orderData.totalParts,
                            timeWindows: orderData.timeWindows,
                            merkleRoot: orderData.merkleRoot, // Use merkle root from orderData (includes leaf hashes)
                            leafHashes: orderData.leafHashes, // Include leaf hashes from orderData
                            order: order.getOrderSummary(),
                            orderState: orderData,
                            timestamp: Date.now()
                        }
                    })
                }
            })

        } catch (error) {
            console.error(`❌ Failed to create order:`, error)
            this.sendToClient(clientId, {
                type: 'ERROR',
                id: message.id,
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Failed to create order'
            })
        }
    }

    /**
     * Handle execute order request
     */
    private async handleExecuteOrder(clientId: string, message: RelayerMessage): Promise<void> {
        const request: ExecuteOrderRequest = message.data
        const clientType = this.clientTypes.get(clientId) || 'UNKNOWN'

        console.log(`🚀 ${clientType} executing order: ${request.orderId}`)

        // Handle resolver's sponsored transaction ready message
        if (request.action === 'SPONSORED_TRANSACTION_READY' && request.finalTransactionBytes) {
            console.log(`   📤 Resolver sending final sponsored transaction bytes to maker for signing`)
            console.log(`   Final transaction bytes length: ${request.finalTransactionBytes.length}`)

            // Broadcast this message to all clients (maker will pick it up)
            this.broadcastToAllClients({
                type: 'EVENT',
                id: message.id,
                success: true,
                data: {
                    type: 'SPONSORED_TRANSACTION_READY',
                    orderId: request.orderId,
                    finalTransactionBytes: request.finalTransactionBytes
                }
            })

            console.log(`✅ Final sponsored transaction bytes sent to maker for signing`)

        } else if (request.makerSignature && clientType === 'MAKER') {
            // Handle maker signature response
            console.log(`   🔐 Maker sending signature for order: ${request.orderId}`)
            console.log(`   Signature length: ${request.makerSignature.length}`)

            // Forward the signature to the resolver
            this.sendToClient(clientId, {
                type: 'ORDER_EXECUTED',
                id: message.id,
                success: true,
                data: {
                    orderId: request.orderId,
                    makerSignature: request.makerSignature,
                    message: 'Maker signature received'
                }
            })

            console.log(`✅ Maker signature forwarded to resolver`)

            // Also notify the resolver directly
            this.notifyOrderSubscribers(request.orderId, {
                type: 'ORDER_EXECUTED',
                id: `signature_${Date.now()}`,
                success: true,
                data: {
                    orderId: request.orderId,
                    makerSignature: request.makerSignature,
                    message: 'Maker signature received'
                }
            })

            console.log(`📤 Also notified resolver about maker signature`)

        } else if (request.evmEscrowAddress && request.suiEscrowId) {
            console.log(`   EVM Escrow: ${request.evmEscrowAddress}`)
            console.log(`   Sui Escrow: ${request.suiEscrowId}`)
            console.log(`   🔐 Resolver has deployed escrows and is requesting secrets from maker`)

            // Find the maker who created this order
            const order = this.orders.get(request.orderId)
            if (!order) {
                throw new Error(`Order not found: ${request.orderId}`)
            }

            // Notify the maker that escrows are deployed and secrets are needed
            this.sendToClient(clientId, {
                type: 'ORDER_EXECUTED',
                id: message.id,
                success: true,
                data: {
                    orderId: request.orderId,
                    evmEscrowAddress: request.evmEscrowAddress,
                    suiEscrowId: request.suiEscrowId,
                    message: 'Escrows deployed successfully. Waiting for maker to provide secrets.'
                }
            })

            console.log(`✅ Notified resolver that escrows deployment was acknowledged`)
            console.log(`📤 Next step: Maker should provide secrets for order ${request.orderId}`)

        } else {
            console.log(`   Taker: ${request.takerAddress || 'Unknown'}`)
            console.log(`   Parts: ${request.partsToFill?.join(', ') || 'None'}`)

            try {
                const orderState = this.bridge.getOrderState(request.orderId)
                if (!orderState) {
                    throw new Error(`Order not found: ${request.orderId}`)
                }

                // Create a mock order object for execution
                const mockOrder = {
                    salt: { toString: () => request.orderId },
                    getSourceChain: () => orderState.sourceChain,
                    getDestinationChain: () => orderState.destinationChain,
                    isSuiToEVM: () => orderState.sourceChain === 'SUI_TESTNET',
                    validateCrossChain: () => { },
                    getOrderSummary: () => ({ orderId: request.orderId })
                } as any

                const success = await this.bridge.executeOrder(mockOrder, request.takerAddress, request.partsToFill)

                const updatedOrderState = this.bridge.getOrderState(request.orderId)

                this.sendToClient(clientId, {
                    type: 'ORDER_EXECUTED',
                    id: message.id,
                    success: true,
                    data: {
                        orderId: request.orderId,
                        success,
                        orderState: updatedOrderState
                    }
                })

                console.log(`✅ Order executed successfully: ${request.orderId}`)

            } catch (error) {
                console.error(`❌ Failed to execute order:`, error)
                this.sendToClient(clientId, {
                    type: 'ERROR',
                    id: message.id,
                    success: false,
                    data: null,
                    error: error instanceof Error ? error.message : 'Failed to execute order'
                })
            }
        }
    }

    /**
     * Handle get orders request
     */
    private async handleGetOrders(clientId: string, message: RelayerMessage): Promise<void> {
        console.log(`📋 Getting all orders for client: ${clientId}`)

        try {
            const orders = this.bridge.getAllOrderStates()

            this.sendToClient(clientId, {
                type: 'ORDERS_LIST',
                id: message.id,
                success: true,
                data: {
                    orders,
                    count: orders.length,
                    timestamp: Date.now()
                }
            })

            console.log(`✅ Sent ${orders.length} orders to client ${clientId}`)

        } catch (error) {
            console.error(`❌ Failed to get orders:`, error)
            this.sendToClient(clientId, {
                type: 'ERROR',
                id: message.id,
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Failed to get orders'
            })
        }
    }

    /**
     * Handle get order status request
     */
    private async handleGetOrderStatus(clientId: string, message: RelayerMessage): Promise<void> {
        const orderId = message.data.orderId

        console.log(`📊 Getting status for order: ${orderId}`)

        try {
            const orderState = this.bridge.getOrderState(orderId)

            if (!orderState) {
                this.sendToClient(clientId, {
                    type: 'ERROR',
                    id: message.id,
                    success: false,
                    data: null,
                    error: `Order not found: ${orderId}`
                })
                return
            }

            this.sendToClient(clientId, {
                type: 'ORDER_STATUS',
                id: message.id,
                success: true,
                data: {
                    orderState,
                    timestamp: Date.now()
                }
            })

            console.log(`✅ Sent order status to client ${clientId}`)

        } catch (error) {
            console.error(`❌ Failed to get order status:`, error)
            this.sendToClient(clientId, {
                type: 'ERROR',
                id: message.id,
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Failed to get order status'
            })
        }
    }

    /**
     * Handle subscribe to events request
     */
    private async handleSubscribeEvents(clientId: string, message: RelayerMessage): Promise<void> {
        const orderIds = message.data.orderIds || []

        console.log(`🔔 Client ${clientId} subscribing to events for orders: ${orderIds.join(', ')}`)

        try {
            // If empty array, subscribe to all orders (global subscription)
            if (orderIds.length === 0) {
                this.globalSubscribers.add(clientId)
                console.log(`🌍 Client ${clientId} subscribed to ALL orders (global subscription)`)

                this.sendToClient(clientId, {
                    type: 'EVENT',
                    id: message.id,
                    success: true,
                    data: {
                        message: `Subscribed to ALL orders (global subscription)`,
                        subscribedOrders: [],
                        isGlobalSubscription: true,
                        timestamp: Date.now()
                    }
                })
            } else {
                // Subscribe to specific orders
                orderIds.forEach((orderId: string) => {
                    if (!this.orderSubscriptions.has(orderId)) {
                        this.orderSubscriptions.set(orderId, new Set())
                    }
                    this.orderSubscriptions.get(orderId)!.add(clientId)

                    if (!this.clientSubscriptions.has(clientId)) {
                        this.clientSubscriptions.set(clientId, new Set())
                    }
                    this.clientSubscriptions.get(clientId)!.add(orderId)
                })

                this.sendToClient(clientId, {
                    type: 'EVENT',
                    id: message.id,
                    success: true,
                    data: {
                        message: `Subscribed to events for ${orderIds.length} orders`,
                        subscribedOrders: orderIds,
                        timestamp: Date.now()
                    }
                })

                console.log(`✅ Client ${clientId} subscribed to ${orderIds.length} orders`)
            }

        } catch (error) {
            console.error(`❌ Failed to subscribe to events:`, error)
            this.sendToClient(clientId, {
                type: 'ERROR',
                id: message.id,
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Failed to subscribe to events'
            })
        }
    }

    /**
     * Handle deployment report from resolver
     */
    private async handleReportDeployment(clientId: string, message: RelayerMessage): Promise<void> {
        const request = message.data
        const clientType = this.clientTypes.get(clientId) || 'UNKNOWN'

        console.log(`\n📋 ${clientType} reporting deployment for order: ${request.orderId}`)
        console.log(`   Sui Escrow: ${request.srcEscrowSuiAddress || 'N/A'}`)
        console.log(`   EVM Escrow: ${request.dstEvmEscrowAddress}`)
        console.log(`   Chain ID: ${request.chainId}`)
        console.log(`   Hashlock: ${request.hashlock}`)

        try {
            // Get the stored order data for validation
            const orderData = this.bridge.getOrderState(request.orderId)
            if (!orderData) {
                throw new Error(`Order ${request.orderId} not found`)
            }

            console.log(`🔍 DEBUG: Retrieved order data for validation:`)
            console.log(`   Merkle Root: ${orderData.merkleRoot || 'MISSING'}`)
            console.log(`   Leaf Hashes: ${orderData.leafHashes?.length || 0} available`)
            if (orderData.leafHashes && orderData.leafHashes.length > 4) {
                console.log(`   Expected hashlock (leaf 5): ${orderData.leafHashes[4]}`)
            }

            // Validate deployment data against stored order
            const validationResult = this.validateDeployment(orderData, request)

            if (validationResult.isValid) {
                console.log(`   ✅ Deployment validation PASSED`)

                // Update order status
                const order = this.orders.get(request.orderId)
                if (order) {
                    order.status = 'DEPLOYED'
                    order.suiEscrowAddress = request.srcEscrowSuiAddress
                    order.evmEscrowAddress = request.dstEvmEscrowAddress
                    this.orders.set(request.orderId, order)
                }

                // Notify maker about successful deployment
                await this.notifyMakerOfDeployment(request.orderId, request)

                // Send success response to resolver
                this.sendToClient(clientId, {
                    type: 'ORDER_EXECUTED',
                    id: message.id,
                    success: true,
                    data: {
                        orderId: request.orderId,
                        message: 'Deployment validated and maker notified',
                        validation: validationResult
                    }
                })
            } else {
                console.log(`   ❌ Deployment validation FAILED: ${validationResult.reason}`)

                // Send failure response to resolver
                this.sendToClient(clientId, {
                    type: 'ERROR',
                    id: message.id,
                    success: false,
                    data: null,
                    error: `Deployment validation failed: ${validationResult.reason || 'Unknown validation error'}`
                })
            }

        } catch (error) {
            console.error(`❌ Failed to handle deployment report:`, error)
            this.sendToClient(clientId, {
                type: 'ERROR',
                id: message.id,
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Failed to process deployment report'
            })
        }
    }

    /**
     * Validate deployment data against stored order
     */
    private validateDeployment(orderData: any, deploymentData: any): { isValid: boolean, reason?: string } {
        console.log(`🔍 Validating deployment against order data...`)

        // Check if order has the expected merkle root and leaf hashes
        if (!orderData.merkleRoot) {
            return { isValid: false, reason: 'Order missing merkle root' }
        }

        if (!orderData.leafHashes || orderData.leafHashes.length < 5) {
            return { isValid: false, reason: `Order missing sufficient leaf hashes (need 5+, got ${orderData.leafHashes?.length || 0})` }
        }

        // Validate that the reported hashlock matches the expected leaf hash (5th one for 5/10 parts)
        const expectedHashlock = orderData.leafHashes[4] // 5th leaf hash (0-indexed)
        console.log(`   🔍 Hashlock validation:`)
        console.log(`     Expected (leaf hash 5): ${expectedHashlock}`)
        console.log(`     Reported by resolver: ${deploymentData.hashlock}`)

        if (deploymentData.hashlock !== expectedHashlock) {
            return {
                isValid: false,
                reason: `Hashlock mismatch. Expected: ${expectedHashlock}, Got: ${deploymentData.hashlock}`
            }
        }

        // Validate chain ID (Base Sepolia)
        if (deploymentData.chainId !== 84532) {
            return { isValid: false, reason: `Invalid chain ID. Expected: 84532, Got: ${deploymentData.chainId}` }
        }

        // Validate timelock consistency (basic check)
        if (deploymentData.evmTimelocks?.dstCancellation && orderData.timeWindows?.dstCancellation) {
            const timeDiff = Math.abs(deploymentData.evmTimelocks.dstCancellation - orderData.timeWindows.dstCancellation)
            if (timeDiff > 3600) { // Allow 1 hour difference
                return {
                    isValid: false,
                    reason: `EVM timelock mismatch. Expected: ~${orderData.timeWindows.dstCancellation}, Got: ${deploymentData.evmTimelocks.dstCancellation}`
                }
            }
        }

        console.log(`   ✅ All validations passed`)
        return { isValid: true }
    }

    /**
     * Notify maker about successful deployment
     */
    private async notifyMakerOfDeployment(orderId: string, deploymentData: any): Promise<void> {
        console.log(`📢 Notifying maker about validated deployment...`)

        // Debug: Show all connected clients
        console.log(`🔍 DEBUG: All connected clients:`)
        for (const [clientId, clientType] of this.clientTypes.entries()) {
            const client = this.clients.get(clientId)
            const isConnected = client && client.readyState === 1 // WebSocket.OPEN = 1
            console.log(`   Client ${clientId}: ${clientType} (Connected: ${isConnected})`)
        }

        // Find maker client (the one who created the order)
        let makerClientId: string | null = null
        for (const [clientId, clientType] of this.clientTypes.entries()) {
            if (clientType === 'MAKER') {
                const client = this.clients.get(clientId)
                const isConnected = client && client.readyState === 1
                if (isConnected) {
                    makerClientId = clientId
                    break
                }
            }
        }

        if (makerClientId) {
            this.sendToClient(makerClientId, {
                type: 'EVENT',
                id: 'deployment_validated',
                success: true,
                data: {
                    type: 'DEPLOYMENT_VALIDATED',
                    orderId: orderId,
                    message: '🎉 Escrows deployed and validated by relayer!',
                    deploymentData: {
                        suiEscrowAddress: deploymentData.srcEscrowSuiAddress,
                        evmEscrowAddress: deploymentData.dstEvmEscrowAddress,
                        chainId: deploymentData.chainId,
                        hashlock: deploymentData.hashlock
                    },
                    timestamp: Date.now()
                }
            })
            console.log(`   📤 Maker notified at client ${makerClientId}`)
        } else {
            console.log(`   ⚠️  No maker client found to notify`)
        }
    }

    /**
     * Handle secret provision from maker
     */
    private async handleProvideSecrets(clientId: string, message: RelayerMessage): Promise<void> {
        const request = message.data
        const clientType = this.clientTypes.get(clientId) || 'UNKNOWN'

        console.log(`\n🔐 ${clientType} providing secrets for order: ${request.orderId}`)
        console.log(`   🔓 Revealed secrets: ${request.revealedSecrets?.length || 0} provided`)
        console.log(`   🌳 Hashed leaves: ${request.hashedLeaves?.length || 0} provided`)
        console.log(`   🔓 EVM secret (4): ${request.evmSecret ? 'Provided' : 'Missing'}`)

        try {
            // Get the stored order data
            const orderData = this.bridge.getOrderState(request.orderId)
            if (!orderData) {
                throw new Error(`Order ${request.orderId} not found`)
            }

            // SECURITY: Verify the partial secrets + hashed leaves match the original merkle root
            if (request.revealedSecrets && request.hashedLeaves) {
                console.log(`   🔍 Verifying partial secrets + hashed leaves against merkle root...`)

                // Convert revealed secrets back to Uint8Array and hash them
                const revealedSecrets = request.revealedSecrets.map((secretArray: number[]) => new Uint8Array(secretArray))
                const { keccak256 } = require('viem')
                const hashedRevealedSecrets = revealedSecrets.map((secret: Uint8Array) => keccak256(secret))

                // Combine hashed revealed secrets + provided hashed leaves
                const allLeafHashes = [...hashedRevealedSecrets, ...request.hashedLeaves]

                // Build tree to verify root (same as maker)
                const { SimpleMerkleTree } = require('@openzeppelin/merkle-tree')
                const ozTree = SimpleMerkleTree.of(allLeafHashes, { sortLeaves: false })

                console.log(`   Expected root: ${orderData.merkleRoot}`)
                console.log(`   Computed root: ${ozTree.root}`)
                console.log(`   Revealed secrets (0-4): ${hashedRevealedSecrets.length}`)
                console.log(`   Hashed leaves (5-10): ${request.hashedLeaves.length}`)

                if (ozTree.root !== orderData.merkleRoot) {
                    throw new Error(`Merkle root mismatch! Partial secrets don't match the original order.`)
                }

                console.log(`   ✅ Partial secrets + hashed leaves verified against merkle root!`)
            }

            // Debug: Check what's in orderData
            console.log(`🔍 DEBUG: Order data fields:`)
            console.log(`   suiEscrowAddress: ${orderData.suiEscrowAddress}`)
            console.log(`   evmEscrowAddress: ${orderData.evmEscrowAddress}`)
            console.log(`   Available fields: ${Object.keys(orderData).join(', ')}`)

            // Use the revealed secrets for authorization (secrets 0-4)
            const suiSecretsForWithdrawal = request.revealedSecrets || []

            // Generate relayer authorization signatures (only for the revealed secrets)
            const authorizationData = await this.generateRelayerAuthorization(
                request.orderId,
                orderData.suiEscrowAddress || request.suiEscrowAddress, // Use fallback from request
                suiSecretsForWithdrawal.map((secretArray: number[]) => new Uint8Array(secretArray)), // Convert to Uint8Array
                request.evmSecret
            )

            // Send authorization back to maker
            this.sendToClient(clientId, {
                type: 'EVENT',
                id: message.id,
                success: true,
                data: {
                    type: 'SECRETS_AUTHORIZED',
                    orderId: request.orderId,
                    message: '🔐 Secrets authorized by relayer',
                    authorizationData: authorizationData,
                    timestamp: Date.now()
                }
            })

            console.log(`   ✅ Relayer authorization generated and sent to maker`)

            // Also send authorized secrets to resolver for escrow unlocking
            await this.sendAuthorizedSecretsToResolver(request.orderId, {
                revealedSecrets: request.revealedSecrets, // Only revealed secrets (0-4)
                hashedLeaves: request.hashedLeaves, // Hashed leaves (5-10) for merkle proof
                evmSecret: request.evmSecret,
                authorizationData: authorizationData
            })

        } catch (error) {
            console.error(`❌ Failed to handle secret provision:`, error)
            this.sendToClient(clientId, {
                type: 'ERROR',
                id: message.id,
                success: false,
                data: null,
                error: error instanceof Error ? error.message : 'Failed to process secrets'
            })
        }
    }

    /**
     * Generate relayer authorization signatures for escrow unlocking
     */
    private async generateRelayerAuthorization(
        orderId: string,
        suiEscrowAddress: string,
        suiSecrets: Uint8Array[],
        evmSecret: Uint8Array
    ): Promise<any> {
        console.log(`🔐 Generating relayer authorization signatures...`)

        // Load relayer private key from environment (try RELAYER_PRIVATE_KEY first, then EVE_PRIVATE_KEY as fallback)
        const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY || process.env.EVE_PRIVATE_KEY
        if (!relayerPrivateKey) {
            throw new Error('RELAYER_PRIVATE_KEY or EVE_PRIVATE_KEY not found in environment variables')
        }

        // Import relayer keypair
        const { Ed25519Keypair } = require('@mysten/sui/keypairs/ed25519')
        const relayerKeypair = Ed25519Keypair.fromSecretKey(relayerPrivateKey)
        const relayerAddress = relayerKeypair.toSuiAddress()

        console.log(`   Relayer address: ${relayerAddress}`)

        // Generate authorization for Sui escrow (range 1-5, which is secrets 0-4)
        const suiAuthorization = await this.generateSuiAuthorization(
            suiEscrowAddress,
            relayerKeypair,
            1, // start_index (1-based)
            5  // end_index (1-based)
        )

        // Generate authorization for EVM escrow (secret 5, which is index 4)
        const evmAuthorization = await this.generateEvmAuthorization(
            evmSecret,
            relayerKeypair
        )

        return {
            suiAuthorization,
            evmAuthorization,
            relayerAddress
        }
    }

    /**
     * Generate Sui escrow authorization signature
     */
    private async generateSuiAuthorization(
        escrowAddress: string,
        relayerKeypair: any,
        startIndex: number,
        endIndex: number
    ): Promise<any> {
        console.log(`   🔐 Generating Sui authorization for range ${startIndex}-${endIndex}`)

        // Create authorization message (same format as in gasless_sponsored_escrow_demo.ts)
        const { toHex, hexToBytes } = require('viem')
        const crypto = require('crypto')

        const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
        const message = this.createRelayerSignatureMessage(
            escrowAddress,
            relayerKeypair.toSuiAddress(),
            startIndex,
            endIndex,
            nonce
        )

        // Sign the message
        const signatureResult = await relayerKeypair.signPersonalMessage(message)

        return {
            signature: signatureResult.signature,
            publicKey: relayerKeypair.getPublicKey().toSuiBytes(),
            nonce: nonce,
            startIndex: startIndex,
            endIndex: endIndex
        }
    }

    /**
     * Generate EVM escrow authorization signature
     */
    private async generateEvmAuthorization(
        secret: Uint8Array,
        relayerKeypair: any
    ): Promise<any> {
        console.log(`   🔐 Generating EVM authorization for secret`)

        // For EVM, we might need a different authorization format
        // For now, we'll create a simple signature of the secret
        const { toHex } = require('viem')

        const message = new Uint8Array([...secret])
        const signatureResult = await relayerKeypair.signPersonalMessage(message)

        return {
            signature: signatureResult.signature,
            publicKey: relayerKeypair.getPublicKey().toSuiBytes(),
            secret: toHex(secret)
        }
    }

    /**
     * Create relayer signature message (same as in gasless_sponsored_escrow_demo.ts)
     */
    private createRelayerSignatureMessage(
        escrowId: string,
        resolverAddress: string,
        startIndex: number,
        endIndex: number,
        nonce: string
    ): Uint8Array {
        const { hexToBytes } = require('viem')

        // Convert escrow ID to bytes (remove 0x prefix and convert to bytes)
        const escrowIdBytes = hexToBytes(escrowId as `0x${string}`)

        // Convert resolver address to bytes (remove 0x prefix and convert to bytes)
        const resolverBytes = hexToBytes(resolverAddress as `0x${string}`)

        // Convert indices to bytes (8 bytes each for u64)
        const startIndexBytes = new Uint8Array(8)
        const endIndexBytes = new Uint8Array(8)
        const startView = new DataView(startIndexBytes.buffer)
        const endView = new DataView(endIndexBytes.buffer)
        startView.setBigUint64(0, BigInt(startIndex), true) // little endian
        endView.setBigUint64(0, BigInt(endIndex), true) // little endian

        // Convert nonce to bytes
        const nonceBytes = hexToBytes(nonce as `0x${string}`)

        // Combine all bytes
        const message = new Uint8Array(
            escrowIdBytes.length +
            resolverBytes.length +
            startIndexBytes.length +
            endIndexBytes.length +
            nonceBytes.length
        )

        let offset = 0
        message.set(escrowIdBytes, offset)
        offset += escrowIdBytes.length
        message.set(resolverBytes, offset)
        offset += resolverBytes.length
        message.set(startIndexBytes, offset)
        offset += startIndexBytes.length
        message.set(endIndexBytes, offset)
        offset += endIndexBytes.length
        message.set(nonceBytes, offset)

        return message
    }

    /**
     * Send authorized secrets to resolver for escrow unlocking
     */
    private async sendAuthorizedSecretsToResolver(orderId: string, secretsData: any): Promise<void> {
        console.log(`📤 Sending authorized secrets to resolver for order: ${orderId}`)

        // Find resolver client
        let resolverClientId: string | null = null
        for (const [clientId, clientType] of this.clientTypes.entries()) {
            if (clientType === 'RESOLVER') {
                const client = this.clients.get(clientId)
                const isConnected = client && client.readyState === 1
                if (isConnected) {
                    resolverClientId = clientId
                    break
                }
            }
        }

        if (resolverClientId) {
            this.sendToClient(resolverClientId, {
                type: 'EVENT',
                id: 'authorized_secrets',
                success: true,
                data: {
                    type: 'AUTHORIZED_SECRETS',
                    orderId: orderId,
                    message: '🔐 Authorized secrets ready for escrow unlocking',
                    secretsData: secretsData,
                    timestamp: Date.now()
                }
            })
            console.log(`   📤 Authorized secrets sent to resolver ${resolverClientId}`)
        } else {
            console.log(`   ⚠️  No resolver client found to send secrets`)
        }
    }

    /**
     * Send message to specific client
     */
    private sendToClient(clientId: string, response: RelayerResponse): void {
        const client = this.clients.get(clientId)
        console.log(`🔍 DEBUG: Sending to client ${clientId}:`)
        console.log(`   Client exists: ${!!client}`)
        console.log(`   Client readyState: ${client?.readyState} (OPEN=1)`)
        console.log(`   Response type: ${response.type}`)

        if (client && client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify(response))
            console.log(`   ✅ Message sent successfully`)
        } else {
            console.warn(`   ⚠️ Client ${clientId} not connected (readyState: ${client?.readyState}), removing from clients`)
            this.clients.delete(clientId)
            this.clientTypes.delete(clientId)
        }
    }

    /**
     * Notify all clients subscribed to an order
     */
    private notifyOrderSubscribers(orderId: string, response: RelayerResponse): void {
        // Notify clients subscribed to this specific order
        const subscribers = this.orderSubscriptions.get(orderId)
        if (subscribers) {
            subscribers.forEach(clientId => {
                this.sendToClient(clientId, response)
            })
        }

        // Also notify global subscribers (clients subscribed to all orders)
        this.globalSubscribers.forEach(clientId => {
            this.sendToClient(clientId, response)
        })

        console.log(`📤 Notified ${subscribers?.size || 0} specific subscribers and ${this.globalSubscribers.size} global subscribers for order ${orderId}`)
    }

    /**
     * Broadcast message to all connected clients
     */
    private broadcastToAllClients(response: RelayerResponse): void {
        this.clients.forEach((client, clientId) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(response))
            } else {
                console.warn(`⚠️ Client ${clientId} not connected, removing from clients`)
                this.clients.delete(clientId)
            }
        })
    }

    /**
     * Handle client disconnect
     */
    private handleClientDisconnect(clientId: string): void {
        // Remove client from all subscriptions
        const subscribedOrders = this.clientSubscriptions.get(clientId)
        if (subscribedOrders) {
            subscribedOrders.forEach(orderId => {
                const orderSubscribers = this.orderSubscriptions.get(orderId)
                if (orderSubscribers) {
                    orderSubscribers.delete(clientId)
                    if (orderSubscribers.size === 0) {
                        this.orderSubscriptions.delete(orderId)
                    }
                }
            })
            this.clientSubscriptions.delete(clientId)
        }

        // Remove from global subscribers
        this.globalSubscribers.delete(clientId)

        // Remove client
        this.clients.delete(clientId)

        console.log(`🧹 Cleaned up subscriptions for client ${clientId}`)
    }

    /**
     * Generate unique client ID
     */
    private generateClientId(): string {
        return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    /**
     * Get server statistics
     */
    getStats() {
        const makers = Array.from(this.clientTypes.values()).filter(type => type === 'MAKER').length
        const resolvers = Array.from(this.clientTypes.values()).filter(type => type === 'RESOLVER').length
        const unknown = Array.from(this.clientTypes.values()).filter(type => type === 'UNKNOWN').length

        return {
            connectedClients: this.clients.size,
            makers,
            resolvers,
            unknown,
            activeOrders: this.bridge.getAllOrderStates().length,
            orderSubscriptions: this.orderSubscriptions.size,
            timestamp: Date.now()
        }
    }
}

// Start the relayer if this file is run directly
if (require.main === module) {
    const port = parseInt(process.env.RELAYER_PORT || '8080')
    const relayer = new WebSocketRelayer(port)

    relayer.start().catch(error => {
        console.error('❌ Failed to start relayer:', error)
        process.exit(1)
    })

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down relayer...')
        await relayer.stop()
        process.exit(0)
    })

    // Log stats every 30 seconds
    setInterval(() => {
        const stats = relayer.getStats()
        console.log(`📊 Stats: ${stats.connectedClients} clients (${stats.makers} makers, ${stats.resolvers} resolvers, ${stats.unknown} unknown), ${stats.activeOrders} orders`)
    }, 30000)
}

module.exports = { WebSocketRelayer }

