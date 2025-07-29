# Sui Cross-Chain Escrow with OpenZeppelin Merkle Trees

A sophisticated cross-chain escrow system for Sui that enables **partial fills** using **OpenZeppelin-compatible Merkle trees** with nullifiers. This system supports atomic cross-chain swaps with multiple fillers working simultaneously.

## 🎯 What This Does

This escrow system enables **cross-chain atomic swaps** where:

1. **Alice** (maker) locks funds on Sui with a Merkle root
2. **Bob** (taker) deposits corresponding funds on destination chain
3. **Multiple fillers** can partially fill the order using different Merkle tree leaves
4. **Secrets are shared** to unlock funds atomically across chains

The system uses **OpenZeppelin's Merkle tree implementation** for compatibility with Solidity contracts, ensuring the same Merkle proofs work on both Sui and Ethereum.

## 🔧 Technical Architecture

### Merkle Tree Structure
```
Root = OpenZeppelin SimpleMerkleTree.of([secret1, secret2, secret3, secret4, secret5])

Leaves (N+1 system):
- secret1 = 20% of order (parts 1-2)
- secret2 = 20% of order (parts 3-4)  
- secret3 = 20% of order (parts 5-6)
- secret4 = 20% of order (parts 7-8)
- secret5 = 20% of order (parts 9-10) + completion secret
```

### Time Windows
- **SRC_WITHDRAWAL**: Only maker can withdraw (with secrets)
- **SRC_PUBLIC_WITHDRAWAL**: Anyone can withdraw (for maker)
- **SRC_CANCELLATION**: Maker gets refund

### Security Features
- **OpenZeppelin Merkle Proofs**: Cryptographic verification
- **Nullifier System**: Prevents double-spending
- **Time-based Access Control**: Different permissions per window
- **Deposit System**: Takers must deposit before withdrawal

## 🚀 Quick Start

### Prerequisites
- Sui CLI installed
- Node.js and npm
- Testnet SUI for gas fees

### 1. Setup Environment
```bash
# Clone the repository
git clone <your-repo>
cd sui-escrows/srcEscrow

# Create .env file
cp .env.example .env
```

### 2. Configure Environment Variables
Edit `.env` file:
```env
# Sui Network
NETWORK=testnet

# Private Keys (generate with: sui client new-address ed25519)
ALICE_PRIVATE_KEY=your_alice_private_key_here
BOB_PRIVATE_KEY=your_bob_private_key_here
RELAYER_PRIVATE_KEY=your_relayer_private_key_here

# Contract IDs (will be filled after deployment)
PACKAGE_ID=
FACTORY_ID=
FACTORY_VERSION=
```

### 3. Deploy Contract
```bash
# Deploy to testnet
sui client publish --gas-budget 100000000 --network testnet

# Copy the package ID from output
# Example: Published Objects: [0x1234...] Package: 0x5678...
```

### 4. Initialize Factory
```bash
# Initialize factory (replace with your package ID)
sui client call --package 0xYOUR_PACKAGE_ID --module srcescrow --function init_factory --gas-budget 10000000 --network testnet

# Copy the factory ID from output
# Example: Created Objects: [0xabcd...]
```

### 5. Update Environment
Update your `.env` file with the new IDs:
```env
PACKAGE_ID=0xYOUR_PACKAGE_ID
FACTORY_ID=0xYOUR_FACTORY_ID
FACTORY_VERSION=YOUR_FACTORY_VERSION
```

### 6. Install Dependencies & Test
```bash
# Install TypeScript dependencies
cd ts-test
npm install

# Run the test
npm run test
```

## 📋 How to Get Required Values

### Private Keys
```bash
# Generate new addresses
sui client new-address ed25519
sui client new-address ed25519
sui client new-address ed25519

# Export private keys
sui client export-private-key <address>
```

### Package ID
After deployment, look for:
```
Published Objects: [0x1234...] Package: 0x5678...
```
The `Package: 0x5678...` is your `PACKAGE_ID`.

### Factory ID
After initialization, look for:
```
Created Objects: [0xabcd...]
```
The `0xabcd...` is your `FACTORY_ID`.

### Factory Version
Get the factory version:
```bash
sui client object 0xYOUR_FACTORY_ID --show-content
```
Look for `"version": "123"` in the output.

## 🔄 Cross-Chain Flow

### 1. Alice Creates Escrow (Sui)
```typescript
// Alice locks 1 SUI with Merkle root
const escrow = await createEscrow(
    aliceKeypair,
    merkleRoot,
    beneficiaryAddress,
    1000000000 // 1 SUI
);
```

### 2. Bob Deposits on Destination Chain
```typescript
// Bob deposits corresponding funds
await depositForPartRange(
    escrowId,
    factoryId,
    factoryVersion,
    bobKeypair,
    1, 5 // Parts 1-5
);
```

### 3. Relayer Shares Secrets
```typescript
// Relayer provides secrets to unlock funds
await withdrawWithRelayerSignature(
    escrowId,
    secrets,
    merkleProofs,
    relayerSignature
);
```

### 4. Bob Withdraws on Destination
```typescript
// Bob withdraws using secrets
await withdrawPartialRange(
    escrowId,
    startSecret,
    endSecret,
    startProof,
    endProof,
    1, 5, // Parts 1-5
    500000 // 50% of escrow
);
```

## 🧪 Testing

### Run Full Test Suite
```bash
cd ts-test
npm run test
```

### Test Output
```
🎯 SOURCE ESCROW WITH RELAYER SIGNATURE
========================================
✅ Escrow created: 0x1234...
✅ Relayer signature generated
✅ Bob withdraws 5/10 parts successfully
✅ Funds transferred to beneficiary
```

### Manual Testing
```bash
# Test specific functions
npm run test:withdrawal
npm run test:deposit
npm run test:refund
```

## 🔐 Security Features

### Merkle Proof Verification
- **OpenZeppelin Compatible**: Same proofs work on Sui and Ethereum
- **Cryptographic Security**: Prevents invalid withdrawals
- **Efficient**: O(log n) proof size

### Nullifier System
- **Double-Spend Prevention**: Each secret can only be used once
- **Automatic Tracking**: NullifierTable prevents reuse
- **Cross-Chain Safety**: Works across multiple chains

### Time Window Security
- **Access Control**: Different permissions per time window
- **Maker Protection**: Only maker can withdraw during private window
- **Public Safety**: Anyone can help during public window

## 📊 Error Codes

- `EINVALID_MERKLE_PROOF` (6): Invalid Merkle proof
- `ENULLIFIER_ALREADY_USED` (7): Secret already used
- `EINVALID_FILL_AMOUNT` (8): Invalid fill amount
- `EESCROW_ALREADY_RESOLVED` (9): Escrow already completed
- `EWINDOW_NOT_ACTIVE` (10): Time window not active
- `EWINDOW_EXPIRED` (11): Time window expired
- `EINVALID_SECRET_INDEX` (12): Invalid secret index
- `EINVALID_AMOUNT` (13): Invalid amount
- `EINVALID_DEPOSITOR` (18): Invalid depositor

## 🔗 Integration Examples

### Frontend Integration
```typescript
// Create escrow
const escrow = await createEscrow({
    amount: "1000000000",
    merkleRoot: merkleTree.root,
    beneficiary: "0x...",
    deadline: Date.now() + 3600000
});

// Withdraw partial
const withdrawal = await withdrawPartial({
    escrowId: escrow.id,
    startSecret: secrets[0],
    endSecret: secrets[4],
    startProof: proofs[0],
    endProof: proofs[4],
    startIndex: 1,
    endIndex: 5,
    amount: "500000000"
});
```

### Solidity Compatibility
```solidity
// Same Merkle proofs work on Ethereum
bool isValid = MerkleProof.verify(
    merkleRoot,
    leaf,
    proof
);
```

## 🏗️ Architecture Benefits

- **Cross-Chain Atomic**: Works across Sui and Ethereum
- **Partial Fills**: Multiple fillers can work simultaneously
- **OpenZeppelin Compatible**: Same Merkle implementation
- **Time-Based Security**: Flexible access control
- **Gas Efficient**: Optimized for Sui's gas model
- **Developer Friendly**: TypeScript SDK included

## 📈 Performance

- **Merkle Proof**: ~200 gas per verification
- **Nullifier Check**: ~50 gas per check
- **Withdrawal**: ~1000 gas per operation
- **Escrow Creation**: ~5000 gas

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit pull request

## 📄 License

MIT License - see LICENSE file for details. 