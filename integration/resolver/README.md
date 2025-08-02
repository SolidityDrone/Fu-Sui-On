# SUI → EVM Resolver

A modular cross-chain resolver that facilitates SUI to EVM escrow swaps.

## 📁 **Folder Structure**

```
resolver/
├── README.md                    # This file
├── index.ts                     # Main entry point
├── types.ts                     # TypeScript interfaces and types
├── websocket-handler.ts         # WebSocket communication with relayer
├── sui-handler.ts              # Sui blockchain transaction handling
├── evm-handler.ts              # EVM blockchain transaction handling
└── sui-to-evm-resolver.ts      # Main resolver orchestration class
```

## 🔧 **Architecture**

### **Main Components:**

1. **`SuiToEvmResolver`** - Main orchestration class that coordinates all operations
2. **`WebSocketHandler`** - Handles all communication with the relayer service
3. **`SuiHandler`** - Manages Sui blockchain operations (escrow creation, unlocking)
4. **`EvmHandler`** - Manages EVM blockchain operations (escrow deployment, withdrawal)

### **Key Features:**

- ✅ **Modular Design**: Clean separation of concerns
- ✅ **Type Safety**: Full TypeScript support with proper interfaces
- ✅ **Error Handling**: Comprehensive error handling and logging
- ✅ **Event-Driven**: Uses EventEmitter pattern for loose coupling
- ✅ **Production Ready**: Implements all discoveries from testing phase

## 🚀 **Usage**

### **Basic Usage:**
```typescript
import { SuiToEvmResolver } from './resolver/index.js';

const resolver = new SuiToEvmResolver();

// Wait for connection
await new Promise<void>((resolve) => {
    resolver.on('connected', resolve);
});

// Subscribe to orders
await resolver.subscribeToAllOrders();
```

### **Running the Demo:**
```bash
npx ts-node resolver/index.ts
```

## 🔑 **Key Discoveries Implemented**

1. **ABI Fix**: Uses `uint256` for address types (not `uint160`) in EVM transactions
2. **Timelocks Packing**: Uses exact SDK `build()` method order for timelock packing
3. **Dynamic Timestamp Correction**: Gets actual block timestamp after deployment and reconstructs timelocks
4. **Immutables Consistency**: Stores corrected immutables from deployment for withdrawal
5. **Signature Flow**: Proper gasless transaction creation and signature handling

## 📋 **Environment Variables Required**

```env
BOB_PRIVATE_KEY=                 # Bob's Sui private key (gas sponsor)
BOB_ETH_PRIVATE_KEY=            # Bob's EVM private key
BASE_SEPOLIA_RPC_URL=           # Base Sepolia RPC endpoint
BASE_ESCROW_FACTORY=            # EVM escrow factory address
SRC_PACKAGE_ID=                 # Sui package ID
SRC_FACTORY_ID=                 # Sui factory ID  
SRC_FACTORY_VERSION=            # Sui factory version
ORDER_HASH=                     # Optional: fixed order hash
```

## 🔄 **Flow Overview**

1. **Connection**: Connects to relayer via WebSocket
2. **Order Processing**: Receives SUI → EVM orders from relayer
3. **Sui Escrow**: Creates gasless transaction for maker to sign
4. **EVM Escrow**: Deploys destination escrow with corrected timelocks
5. **Validation**: Reports deployment to relayer for validation
6. **Unlocking**: Handles authorized secrets to unlock both escrows
