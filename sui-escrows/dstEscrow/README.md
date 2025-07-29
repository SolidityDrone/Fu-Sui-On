# Sui Destination Escrow with OpenZeppelin Merkle Trees

A sophisticated destination chain escrow system for Sui that enables **partial fills** using **OpenZeppelin-compatible Merkle trees** with a deposit system. This system works in conjunction with the source escrow to enable atomic cross-chain swaps.

## 🎯 What This Does

This destination escrow system enables **cross-chain atomic swaps** where:

1. **Bob** (taker) deposits funds on destination chain before withdrawal
2. **Alice** (maker from source chain) receives all funds when secrets are shared
3. **Multiple fillers** can partially fill using different Merkle tree leaves
4. **Deposit system** ensures only authorized takers can withdraw specific parts

The system uses **OpenZeppelin's Merkle tree implementation** for compatibility with Solidity contracts, ensuring the same Merkle proofs work on both Sui and Ethereum.

## 🔧 Technical Architecture

### Merkle Tree Structure
```
Root = OpenZeppelin SimpleMerkleTree.of([secret1, secret2, secret3, secret4, secret5])

Leaves (10 parts system):
- secret1 = Parts 1-2 (20% of order)
- secret2 = Parts 3-4 (20% of order)  
- secret3 = Parts 5-6 (20% of order)
- secret4 = Parts 7-8 (20% of order)
- secret5 = Parts 9-10 (20% of order) + completion secret
```

### Deposit System
- **Part Deposits**: Takers must deposit for specific part ranges before withdrawal
- **Depositor Tracking**: `Table<u64, address>` tracks which address deposited for which parts
- **Authorization**: Only the depositor can withdraw during private window

### Time Windows
- **DST_WITHDRAWAL**: Only depositor can withdraw their parts
- **DST_PUBLIC_WITHDRAWAL**: Anyone can withdraw (for maker)
- **DST_CANCELLATION**: Money goes back to original depositors

### Security Features
- **OpenZeppelin Merkle Proofs**: Cryptographic verification
- **Nullifier System**: Prevents double-spending
- **Deposit Authorization**: Only depositors can withdraw their parts
- **Time-based Access Control**: Different permissions per window

## 🚀 Quick Start

### Prerequisites
- Sui CLI installed
- Node.js and npm
- Testnet SUI for gas fees

### 1. Setup Environment
```bash
# Clone the repository
git clone <your-repo>
cd sui-escrows/dstEscrow

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
sui client call --package 0xYOUR_PACKAGE_ID --module dstescrow --function init_factory --gas-budget 10000000 --network testnet

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

### 1. Bob Creates Destination Escrow
```typescript
// Bob creates escrow with beneficiary (Alice from source chain)
const escrow = await createDestinationEscrow(
    bobKeypair,
    merkleRoot,
    aliceAddress, // Beneficiary from source chain
    100000000 // 100,000 MIST
);
```

### 2. Bob Deposits for Parts
```typescript
// Bob deposits for parts 1-5 before withdrawal
await depositForPartRange(
    escrowId,
    factoryId,
    factoryVersion,
    bobKeypair,
    1, 5 // Parts 1-5
);
```

### 3. Bob Withdraws Using Secrets
```typescript
// Bob withdraws parts 1-5 using secrets from source chain
await withdrawPartialRange(
    escrowId,
    startSecret,
    endSecret,
    startProof,
    endProof,
    1, 5, // Parts 1-5
    50000 // 50% of escrow
);
```

### 4. Funds Go to Alice (Beneficiary)
```typescript
// All withdrawn funds are automatically sent to Alice
// (the maker from the source chain)
```

## 🧪 Testing

### Run Full Test Suite
```bash
cd ts-test
npm run test
```

### Test Output
```
🎯 DESTINATION ESCROW WITH DEPOSIT SYSTEM
=========================================
✅ Merkle tree generated with OpenZeppelin
✅ Destination escrow created: 0x1234...
✅ Bob deposits for parts 1-5
✅ Bob withdraws 5/10 parts successfully
✅ Funds transferred to beneficiary (Alice)
```

### Manual Testing
```bash
# Test specific functions
npm run test:deposit
npm run test:withdrawal
npm run test:refund
```

## 🔐 Security Features

### Merkle Proof Verification
- **OpenZeppelin Compatible**: Same proofs work on Sui and Ethereum
- **Cryptographic Security**: Prevents invalid withdrawals
- **Efficient**: O(log n) proof size

### Deposit System
- **Part Authorization**: Only depositors can withdraw their parts
- **Deposit Tracking**: `Table<u64, address>` prevents unauthorized withdrawals
- **Cross-Chain Safety**: Works across multiple chains

### Time Window Security
- **Access Control**: Different permissions per time window
- **Depositor Protection**: Only depositor can withdraw during private window
- **Public Safety**: Anyone can help during public window
- **Refund Safety**: Original depositors get refunds during cancellation

## 📊 Error Codes

- `EINVALID_MERKLE_PROOF` (6): Invalid Merkle proof
- `ENULLIFIER_ALREADY_USED` (7): Secret already used
- `EINVALID_FILL_AMOUNT` (8): Invalid fill amount
- `EESCROW_ALREADY_RESOLVED` (9): Escrow already completed
- `EWINDOW_NOT_ACTIVE` (10): Time window not active
- `EWINDOW_EXPIRED` (11): Time window expired
- `EINVALID_SECRET_INDEX` (12): Invalid secret index
- `EINVALID_AMOUNT` (13): Invalid amount
- `EPART_NOT_DEPOSITED` (17): Part not deposited
- `EINVALID_DEPOSITOR` (18): Invalid depositor

## 🔗 Integration Examples

### Frontend Integration
```typescript
// Create destination escrow
const escrow = await createDestinationEscrow({
    amount: "100000000",
    merkleRoot: merkleTree.root,
    beneficiary: "0x...", // Alice from source chain
    deadline: Date.now() + 3600000
});

// Deposit for parts
await depositForPartRange({
    escrowId: escrow.id,
    startPart: 1,
    endPart: 5,
    amount: "50000000"
});

// Withdraw partial
const withdrawal = await withdrawPartialRange({
    escrowId: escrow.id,
    startSecret: secrets[0],
    endSecret: secrets[4],
    startProof: proofs[0],
    endProof: proofs[4],
    startIndex: 1,
    endIndex: 5,
    amount: "50000000"
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
- **Deposit Security**: Takers must deposit before withdrawal
- **OpenZeppelin Compatible**: Same Merkle implementation
- **Time-Based Security**: Flexible access control
- **Gas Efficient**: Optimized for Sui's gas model
- **Developer Friendly**: TypeScript SDK included

## 📈 Performance

- **Merkle Proof**: ~200 gas per verification
- **Nullifier Check**: ~50 gas per check
- **Deposit**: ~500 gas per part range
- **Withdrawal**: ~1000 gas per operation
- **Escrow Creation**: ~5000 gas

## 🔄 Key Differences from Source Escrow

| Feature | Source Escrow | Destination Escrow |
|---------|---------------|-------------------|
| **Deposit System** | No deposit required | Takers must deposit for parts |
| **Beneficiary** | Funds go to specific takers | All funds go to single beneficiary |
| **Authorization** | Only assigned taker can withdraw | Only depositor can withdraw their parts |
| **Time Windows** | SRC_WITHDRAWAL, SRC_PUBLIC_WITHDRAWAL, SRC_CANCELLATION | DST_WITHDRAWAL, DST_PUBLIC_WITHDRAWAL, DST_CANCELLATION |
| **Refund Logic** | Maker gets refund | Original depositors get refunds |

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit pull request

## 📄 License

MIT License - see LICENSE file for details. 