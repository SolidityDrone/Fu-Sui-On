# Sui Merkle Tree Escrow Contract

A sophisticated escrow contract for native Sui coin (0x2::sui::SUI) that supports **partial fills** using **Merkle trees with nullifiers**, similar to ZK systems.

## Features

- **Merkle Tree Escrow**: Root contains 4 hashes (h(x₁), h(x₂), h(x₃), h(x₄))
- **Partial Fills**: Unlock 25%, 50%, 75%, or 100% of the order
- **Nullifier System**: Prevents double-spending of secrets
- **Cross-Chain Swap Support**: Integration with 1inch Fusion+ style flows
- **Sponsored Transactions**: Bob can execute transactions on Alice's behalf

## Merkle Tree Structure

```
Root = h(h(x₁) || h(x₂) || h(x₃) || h(x₄))

Leaves:
- x₁ = 25% of order
- x₂ = 25% of order  
- x₃ = 25% of order
- x₄ = 25% of order
```

## Partial Fill Flow

### 1. Create Escrow with Merkle Root
```move
// Alice creates swap request
let swap_request = srcescrow::create_swap_request(
    b"ethereum",
    b"0xA0b86a33E6441b8c4",
    1000000, // 1 SUI
    signature,
    public_key,
    ctx
);

// Bob creates escrow with Merkle root
let (escrow, nullifier_table) = srcescrow::create_escrow_from_swap(
    swap_request,
    alice_coins,
    @0xReceiver,
    merkle_root, // Root of h(x₁), h(x₂), h(x₃), h(x₄)
    ctx
);
```

### 2. Partial Fill Examples

#### Fill 25% (x₁)
```move
// Provide secret x₁ + Merkle proof
let coin_25 = srcescrow::unlock_partial(
    &mut escrow,
    &mut nullifier_table,
    x1_secret,      // Secret for x₁
    merkle_proof_1, // Proof that h(x₁) is in root
    0,              // Leaf index 0
    ctx
);
// Returns 25% of funds (250,000 MIST)
```

#### Fill 75% (x₃)
```move
// Provide secret x₃ + Merkle proof
let coin_75 = srcescrow::unlock_partial(
    &mut escrow,
    &mut nullifier_table,
    x3_secret,      // Secret for x₃
    merkle_proof_3, // Proof that h(x₃) is in root
    2,              // Leaf index 2
    ctx
);
// Returns 25% of funds (250,000 MIST)
// Total filled: 50% (x₁ + x₃)
```

#### Fill 100% (x₄)
```move
// Provide secret x₄ + Merkle proof
let coin_100 = srcescrow::unlock_full(
    escrow,
    &mut nullifier_table,
    x4_secret,      // Secret for x₄
    merkle_proof_4, // Proof that h(x₄) is in root
    3,              // Leaf index 3 (last leaf)
    ctx
);
// Returns ALL remaining funds and nullifies x₁, x₂, x₃ automatically
```

## Nullifier System

- **Prevents Double-Spending**: Each secret can only be used once
- **Automatic Nullification**: Using x₄ automatically nullifies x₁, x₂, x₃
- **State Tracking**: NullifierTable tracks which secrets have been used

## Functions

### Core Functions
- `create_swap_request()` - Alice creates swap request with signature
- `create_escrow_from_swap()` - Bob creates escrow with Merkle root
- `create_escrow()` - Direct escrow creation with Merkle root

### Unlock Functions
- `unlock_partial()` - Unlock partial amount (25%, 50%, 75%)
- `unlock_full()` - Unlock full amount (100%, nullifies all others)
- `refund_escrow()` - Refund to depositor (before locking)

### Query Functions
- `get_escrow_info()` - Get complete escrow information
- `is_nullifier_used()` - Check if nullifier is already used
- `get_escrow_amount()` - Get remaining Sui amount

## Security Features

- **Merkle Proof Verification**: Cryptographic proof of inclusion
- **Nullifier Protection**: Prevents double-spending
- **Partial Fill Logic**: Ensures correct percentage calculations
- **Access Control**: Only authorized parties can lock/refund

## Error Codes

- `EINVALID_MERKLE_PROOF`: Invalid Merkle proof
- `ENULLIFIER_ALREADY_USED`: Secret already used
- `EINVALID_FILL_AMOUNT`: Invalid fill amount
- `EESCROW_ALREADY_LOCKED`: Escrow is locked
- `EESCROW_NOT_LOCKED`: Escrow is not locked
- `EUNAUTHORIZED`: Unauthorized operation

## Usage Examples

### Frontend Integration
```javascript
// Alice creates swap request
const swapRequest = await createSwapRequest({
    targetChain: "ethereum",
    targetToken: "0xA0b86a33E6441b8c4",
    amount: "1000000",
    signature: await wallet.signMessage(message)
});

// Bob fills 75% of the order
const partialFill = await unlockPartial({
    escrowId: escrow.id,
    secret: x3_secret,
    merkleProof: merkle_proof_3,
    leafIndex: 2
});
```

### Testing
```bash
# Run tests
sui move test

# Deploy to testnet
sui client publish --gas-budget 10000000 --network testnet
```

## Integration with 1inch Fusion+

This contract enables **atomic partial fills** for cross-chain swaps:

1. **Alice** creates swap request with Merkle root
2. **1inch** finds multiple fillers for different portions
3. **Filler 1** fills 25% using x₁
4. **Filler 2** fills 50% using x₃  
5. **Filler 3** fills remaining 25% using x₄

Each filler can execute independently, and the nullifier system ensures no double-spending.

## Merkle Tree Benefits

- **Efficient**: O(log n) proof size
- **Flexible**: Any combination of partial fills
- **Secure**: Cryptographic proofs prevent fraud
- **Composable**: Multiple fillers can work simultaneously 