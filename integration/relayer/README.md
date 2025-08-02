# WebSocket Relayer for Sui ↔ EVM Cross-Chain Bridge

This WebSocket relayer manages cross-chain orders between Sui and EVM chains, providing real-time communication for your hackathon demo.

## 🚀 Quick Start

### 1. Start the Relayer

In one terminal, start the WebSocket relayer:

```bash
cd integration
npm run relayer
```

This will start the relayer on `ws://localhost:8080`

### 2. Connect with Client

In another terminal, run the client demo:

```bash
cd integration
npm run client
```

## 📡 How It Works

### Relayer Features

- **WebSocket Server**: Real-time bidirectional communication
- **Order Management**: Create, execute, and track cross-chain orders
- **Event Broadcasting**: Notify clients of order updates
- **Subscription System**: Clients can subscribe to specific orders
- **Bridge Integration**: Uses the Sui ↔ EVM bridge service

### Client Features

- **Order Creation**: Create SUI → USDC and USDC → SUI orders
- **Order Execution**: Execute partial fills (5/10, 3/10, etc.)
- **Real-time Updates**: Receive events as orders progress
- **Order Queries**: Get order status and list all orders

## 🔧 API Reference

### Message Types

#### Create Order
```typescript
{
  type: 'CREATE_ORDER',
  id: 'unique_id',
  data: {
    sourceChain: CustomNetworkEnum.SUI_TESTNET,
    destinationChain: CustomNetworkEnum.BASE_SEPOLIA,
    makerAddress: '0x...',
    makerAsset: '0x2::sui::SUI',
    takerAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
    makingAmount: '1000000000',
    takingAmount: '2000000000',
    totalParts: 10,
    timeWindows: { ... }
  }
}
```

#### Execute Order
```typescript
{
  type: 'EXECUTE_ORDER',
  id: 'unique_id',
  data: {
    orderId: 'order_id',
    takerAddress: '0x...',
    partsToFill: [0, 1, 2, 3, 4]
  }
}
```

#### Get Orders
```typescript
{
  type: 'GET_ORDERS',
  id: 'unique_id',
  data: {}
}
```

#### Subscribe to Events
```typescript
{
  type: 'SUBSCRIBE_EVENTS',
  id: 'unique_id',
  data: {
    orderIds: ['order_id_1', 'order_id_2']
  }
}
```

### Response Types

- `ORDER_CREATED` - Order was successfully created
- `ORDER_EXECUTED` - Order execution completed
- `ORDER_STATUS` - Current order status
- `ORDERS_LIST` - List of all orders
- `EVENT` - Real-time event updates
- `ERROR` - Error responses

## 🎯 Demo Scenarios

### Scenario 1: SUI → USDC Swap

1. **Create Order**: Maker creates order to swap 1 SUI for 2 USDC
2. **Partial Fill**: Taker executes 5/10 parts (0.5 SUI → 1 USDC)
3. **Another Fill**: Taker executes 3/10 parts (0.3 SUI → 0.6 USDC)
4. **Remaining**: 2/10 parts still available

### Scenario 2: USDC → SUI Swap

1. **Create Order**: Maker creates order to swap 1 USDC for 0.5 SUI
2. **Full Fill**: Taker executes all 10/10 parts at once
3. **Complete**: Order fully executed

## 🔌 WebSocket Connection

### Connect to Relayer
```javascript
const ws = new WebSocket('ws://localhost:8080')

ws.onopen = () => {
  console.log('Connected to relayer')
}

ws.onmessage = (event) => {
  const response = JSON.parse(event.data)
  console.log('Received:', response)
}
```

### Send Message
```javascript
const message = {
  type: 'CREATE_ORDER',
  id: 'msg_1',
  data: { ... }
}

ws.send(JSON.stringify(message))
```

## 🏗️ Architecture

```
┌─────────────┐    WebSocket    ┌─────────────┐    Bridge API    ┌─────────────┐
│   Client    │ ◄─────────────► │   Relayer   │ ◄─────────────► │   Bridge    │
│             │                 │             │                 │             │
│ - Create    │                 │ - Manage    │                 │ - Sui       │
│ - Execute   │                 │ - Route     │                 │ - EVM       │
│ - Subscribe │                 │ - Broadcast │                 │ - Orders    │
└─────────────┘                 └─────────────┘                 └─────────────┘
```

## 🎉 Hackathon Benefits

1. **Real-time Communication**: WebSocket for instant updates
2. **Multiple Clients**: Multiple resolvers can connect simultaneously
3. **Order Management**: Centralized order tracking and execution
4. **Event Broadcasting**: All clients get real-time order updates
5. **Easy Integration**: Simple WebSocket API for frontend integration

## 🚀 Next Steps

1. **Deploy Relayer**: Deploy to production server
2. **Add Authentication**: Secure WebSocket connections
3. **Add Rate Limiting**: Prevent spam and abuse
4. **Add Monitoring**: Track performance and errors
5. **Add Web UI**: Create user interface for orders

---

**Ready for your hackathon demo! 🚀** 