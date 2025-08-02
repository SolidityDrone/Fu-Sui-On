import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { RelayerMessage, RelayerResponse, DeploymentData } from './types';

export class WebSocketHandler extends EventEmitter {
    private ws: WebSocket;
    private connected: boolean = false;
    private messageId: number = 0;
    private pendingRequests: Map<string, { resolve: Function, reject: Function }> = new Map();

    constructor(url: string = 'ws://localhost:8080') {
        super();
        this.ws = new WebSocket(url);
        this.setupWebSocket();
    }

    /**
     * Setup WebSocket connection
     */
    private setupWebSocket(): void {
        this.ws.on('open', () => {
            this.connected = true;
            console.log('🔌 Resolver connected to relayer');
            this.emit('connected');
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const response: RelayerResponse = JSON.parse(data.toString());
                this.handleResponse(response);
            } catch (error) {
                console.error('❌ Error parsing response:', error);
            }
        });

        this.ws.on('close', () => {
            this.connected = false;
            console.log('🔌 Resolver disconnected from relayer');
            this.emit('disconnected');
        });

        this.ws.on('error', (error: Error) => {
            console.error('❌ WebSocket error:', error);
            this.emit('error', error);
        });
    }

    /**
     * Handle responses from relayer
     */
    private handleResponse(response: RelayerResponse): void {
        console.log(`📨 Response: ${response.type} (${response.success ? '✅' : '❌'})`);

        // Handle pending requests
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
            this.pendingRequests.delete(response.id);
            if (response.success) {
                pending.resolve(response.data);
            } else {
                pending.reject(new Error(response.error || 'Unknown error'));
            }
        }

        // Emit events for real-time updates
        this.emit(response.type.toLowerCase(), response.data);

        // Log response details
        if (response.type === 'ORDER_CREATED') {
            console.log(`   Order ID: ${response.data?.orderId || 'Unknown'}`);
            console.log(`   Direction: ${response.data?.sourceChain || 'Unknown'} → ${response.data?.destinationChain || 'Unknown'}`);
            console.log(`   Amount: ${response.data?.makingAmount || 'Unknown'} → ${response.data?.takingAmount || 'Unknown'}`);

            // DEBUG: Log the full response data structure
            console.log(`🔍 DEBUG: Full response.data structure:`);
            console.log(JSON.stringify(response.data, null, 2));
        } else if (response.type === 'ORDER_EXECUTED') {
            console.log(`   Order ID: ${response.data?.orderId || 'Unknown'}`);
            console.log(`   Success: ${response.data?.success || 'Unknown'}`);

            // Check if this is a maker signature response
            if (response.data?.makerSignature && response.data?.orderId) {
                console.log(`🔐 Received maker signature for order: ${response.data.orderId}`);
                console.log(`   Signature length: ${response.data.makerSignature.length}`);

                // Emit signature received event
                this.emit('maker_signature_received', response.data);
            }
        } else if (response.type === 'EVENT') {
            console.log(`   Event type: ${response.data?.type || 'unknown'}`);
        } else if (response.type === 'ORDERS_LIST') {
            console.log(`   Received ${response.data?.length || 0} orders from relayer`);
            if (response.data && response.data.length > 0) {
                console.log(`🔍 Processing existing orders...`);
                response.data.forEach((order: any) => {
                    console.log(`   Processing existing order: ${order.orderId}`);
                    this.emit('existing_order', order);
                });
            }
        }
    }

    /**
     * Send message to relayer
     */
    sendMessage(message: RelayerMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.connected) {
                reject(new Error('Not connected to relayer'));
                return;
            }

            this.pendingRequests.set(message.id, { resolve, reject });
            this.ws.send(JSON.stringify(message));
        });
    }

    /**
     * Generate unique message ID
     */
    generateMessageId(): string {
        return `resolver_${++this.messageId}_${Date.now()}`;
    }

    /**
     * Subscribe to all orders
     */
    async subscribeToAllOrders(): Promise<any> {
        console.log(`🔍 Subscribing to all orders...`);
        const message: RelayerMessage = {
            type: 'SUBSCRIBE_EVENTS',
            id: this.generateMessageId(),
            data: { orderIds: [] }, // Empty array means subscribe to all
            clientType: 'RESOLVER'
        };

        console.log(`📤 Sending subscription message: ${JSON.stringify(message)}`);
        return this.sendMessage(message);
    }

    /**
     * Get all orders
     */
    async getAllOrders(): Promise<any> {
        console.log(`🔍 Getting all existing orders...`);
        const message: RelayerMessage = {
            type: 'GET_ORDERS',
            id: this.generateMessageId(),
            data: {},
            clientType: 'RESOLVER'
        };

        console.log(`📤 Sending get orders message: ${JSON.stringify(message)}`);
        return this.sendMessage(message);
    }

    /**
     * Report deployment results to relayer for validation
     */
    async reportDeploymentToRelayer(orderId: string, deploymentData: DeploymentData): Promise<void> {
        console.log(`\n📤 Reporting deployment results to relayer for validation...`);
        console.log(`   Order ID: ${orderId}`);
        console.log(`   Sui Escrow: ${deploymentData.srcEscrowSuiAddress || 'N/A'}`);
        console.log(`   EVM Escrow: ${deploymentData.dstEvmEscrowAddress}`);
        console.log(`   Chain ID: ${deploymentData.chainId}`);
        console.log(`   Hashlock: ${deploymentData.hashlock}`);

        const message: RelayerMessage = {
            type: 'REPORT_DEPLOYMENT',
            id: this.generateMessageId(),
            data: {
                orderId,
                ...deploymentData
            },
            clientType: 'RESOLVER'
        };

        try {
            const responseData = await this.sendMessage(message);
            console.log(`   ✅ Deployment report sent to relayer`);
            console.log(`   🔍 DEBUG: Full relayer response:`, JSON.stringify(responseData, null, 2));

            // Check if validation passed (responseData contains the data, not the full response)
            const isValidated = responseData.validation?.isValid === true;
            console.log(`   📋 Relayer response: ${isValidated ? 'VALIDATED' : 'REJECTED'}`);

            if (!isValidated) {
                console.error(`   ❌ Relayer rejected deployment: ${responseData.message || 'Unknown error'}`);
            } else {
                console.log(`   ✅ Relayer validated deployment successfully!`);
            }
        } catch (error) {
            console.error(`   ❌ Failed to report deployment to relayer:`, error);
        }
    }

    /**
     * Send finalTxBytes to relayer for maker to sign
     */
    async sendTransactionForSigning(orderId: string, finalTxBytes: Uint8Array): Promise<void> {
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
        };

        console.log(`📤 Sending SPONSORED_TRANSACTION_READY event to relayer`);
        await this.sendMessage(message);
    }

    /**
     * Close connection
     */
    close(): void {
        this.ws.close();
    }
}