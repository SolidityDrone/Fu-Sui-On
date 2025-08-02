// Types for WebSocket communication
export interface RelayerMessage {
    type: 'CREATE_ORDER' | 'EXECUTE_ORDER' | 'GET_ORDERS' | 'GET_ORDER_STATUS' | 'SUBSCRIBE_EVENTS' | 'REPORT_DEPLOYMENT' | 'PROVIDE_SECRETS' | 'AUTHORIZED_SECRETS'
    id: string
    data: any
    clientType?: string // Added for client identification
}

export interface RelayerResponse {
    type: 'ORDER_CREATED' | 'ORDER_EXECUTED' | 'ORDER_STATUS' | 'ORDERS_LIST' | 'EVENT' | 'ERROR'
    id: string
    success: boolean
    data: any
    error?: string
}

export interface CrossChainOrder {
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
    partsToFill?: number // Store how many parts this resolver will fill
    timeWindows: {
        srcWithdrawal: number
        srcPublicWithdrawal: number
        srcCancellation: number
        dstWithdrawal: number
        dstPublicWithdrawal: number
        dstCancellation: number
    }
}

export interface DeploymentData {
    srcEscrowSuiAddress?: string
    dstEvmEscrowAddress: string
    chainId: number
    hashlock: string
    partsToFill: number // Add this to tell relayer how many parts resolver wants to fill
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
}