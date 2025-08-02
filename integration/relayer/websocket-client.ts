#!/usr/bin/env ts-node

import WebSocket from 'ws'
import { EventEmitter } from 'events'

// Types for client communication
export interface RelayerMessage {
    type: 'CREATE_ORDER' | 'EXECUTE_ORDER' | 'GET_ORDERS' | 'GET_ORDER_STATUS' | 'SUBSCRIBE_EVENTS'
    id: string
    data: any
}

export interface RelayerResponse {
    type: 'ORDER_CREATED' | 'ORDER_EXECUTED' | 'ORDER_STATUS' | 'ORDERS_LIST' | 'EVENT' | 'ERROR'
    id: string
    success: boolean
    data: any
    error?: string
}

export class WebSocketClient extends EventEmitter {
    private ws: WebSocket
    private connected: boolean = false
    private messageId: number = 0
    private pendingRequests: Map<string, { resolve: Function, reject: Function }> = new Map()

    constructor(url: string = 'ws://localhost:8080') {
        super()
        this.ws = new WebSocket(url)
        this.setupWebSocket()
    }

    /**
     * Setup WebSocket connection
     */
    private setupWebSocket(): void {
        this.ws.on('open', () => {
            this.connected = true
            console.log('🔌 Connected to relayer')
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
            console.log(`   Direction: ${response.data.order.direction}`)
        } else if (response.type === 'ORDER_EXECUTED') {
            console.log(`   Order ID: ${response.data.orderId}`)
            console.log(`   Success: ${response.data.success}`)
        } else if (response.type === 'EVENT') {
            console.log(`   Event type: ${response.data?.type || 'unknown'}`)
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
     * Create a cross-chain order
     */
    async createOrder(request: {
        sourceChain: any // CustomNetworkEnum
        destinationChain: any // CustomNetworkEnum
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
        const message: RelayerMessage = {
            type: 'CREATE_ORDER',
            id: this.generateMessageId(),
            data: {
                ...request,
                totalParts: request.totalParts || 10,
                timeWindows: request.timeWindows || {
                    srcWithdrawal: Math.floor(Date.now() / 1000) + 3600,
                    srcPublicWithdrawal: Math.floor(Date.now() / 1000) + 7200,
                    srcCancellation: Math.floor(Date.now() / 1000) + 1800,
                    dstWithdrawal: Math.floor(Date.now() / 1000) + 3600,
                    dstPublicWithdrawal: Math.floor(Date.now() / 1000) + 7200,
                    dstCancellation: Math.floor(Date.now() / 1000) + 1800
                }
            }
        }

        return this.sendMessage(message)
    }

    /**
     * Execute a cross-chain order
     */
    async executeOrder(orderId: string, takerAddress: string, partsToFill: number[]): Promise<any> {
        const message: RelayerMessage = {
            type: 'EXECUTE_ORDER',
            id: this.generateMessageId(),
            data: {
                orderId,
                takerAddress,
                partsToFill
            }
        }

        return this.sendMessage(message)
    }

    /**
     * Get all orders
     */
    async getOrders(): Promise<any> {
        const message: RelayerMessage = {
            type: 'GET_ORDERS',
            id: this.generateMessageId(),
            data: {}
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
            data: { orderId }
        }

        return this.sendMessage(message)
    }

    /**
     * Subscribe to order events
     */
    async subscribeToEvents(orderIds: string[]): Promise<any> {
        const message: RelayerMessage = {
            type: 'SUBSCRIBE_EVENTS',
            id: this.generateMessageId(),
            data: { orderIds }
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

// Example usage
async function demonstrateClient() {
    console.log('🎯 WebSocket Client Demo')
    console.log('='.repeat(40))

    const client = new WebSocketClient()

    // Wait for connection
    await new Promise<void>((resolve) => {
        client.on('connected', resolve)
    })

    // Subscribe to events
    client.on('event', (data) => {
        console.log('📡 Received event type:', data.type)
    })

    try {
        // Create a SUI → USDC order
        console.log('\n📝 Creating SUI → USDC order...')
        const order1 = await client.createOrder({
            sourceChain: 'SUI_TESTNET', // CustomNetworkEnum.SUI_TESTNET
            destinationChain: 'BASE_SEPOLIA', // CustomNetworkEnum.BASE_SEPOLIA
            makerAddress: '0x1234567890abcdef1234567890abcdef1234567890',
            makerAsset: '0x2::sui::SUI',
            takerAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
            makingAmount: '1000000000', // 1 SUI
            takingAmount: '2000000000', // 2 USDC
            totalParts: 10
        })

        console.log('✅ Order created:', order1.orderId)

        // Subscribe to events for this order
        await client.subscribeToEvents([order1.orderId])

        // Execute partial fill (5/10 parts)
        console.log('\n🚀 Executing partial fill (5/10 parts)...')
        const execution1 = await client.executeOrder(
            order1.orderId,
            '0xabcdef1234567890abcdef1234567890abcdef1234',
            [0, 1, 2, 3, 4]
        )

        console.log('✅ Partial fill executed:', execution1.success)

        // Create a USDC → SUI order
        console.log('\n📝 Creating USDC → SUI order...')
        const order2 = await client.createOrder({
            sourceChain: 'BASE_SEPOLIA', // CustomNetworkEnum.BASE_SEPOLIA
            destinationChain: 'SUI_TESTNET', // CustomNetworkEnum.SUI_TESTNET
            makerAddress: '0x9876543210fedcba9876543210fedcba9876543210',
            makerAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
            takerAsset: '0x2::sui::SUI',
            makingAmount: '1000000000', // 1 USDC
            takingAmount: '500000000', // 0.5 SUI
            totalParts: 10
        })

        console.log('✅ Order created:', order2.orderId)

        // Subscribe to events for this order too
        await client.subscribeToEvents([order2.orderId])

        // Execute full fill (10/10 parts)
        console.log('\n🚀 Executing full fill (10/10 parts)...')
        const execution2 = await client.executeOrder(
            order2.orderId,
            '0xfedcba0987654321fedcba0987654321fedcba0987',
            [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        )

        console.log('✅ Full fill executed:', execution2.success)

        // Get all orders
        console.log('\n📋 Getting all orders...')
        const orders = await client.getOrders()
        console.log(`✅ Found ${orders.count} orders`)

        // Get status of first order
        console.log('\n📊 Getting order status...')
        const status = await client.getOrderStatus(order1.orderId)
        console.log('✅ Order status:', status.orderState.status)

        // Wait a bit for events
        console.log('\n⏳ Waiting for events...')
        await new Promise(resolve => setTimeout(resolve, 5000))

    } catch (error) {
        console.error('❌ Error:', error)
    } finally {
        client.close()
    }
}

// Run demo if this file is executed directly
if (require.main === module) {
    demonstrateClient().catch(console.error)
}

