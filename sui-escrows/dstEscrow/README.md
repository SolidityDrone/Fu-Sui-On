# Destination Escrow (dstEscrow)

This module implements a destination escrow system for cross-chain HTLC (Hash Time-Locked Contract) operations. Unlike the source escrow which handles multiple takers, this destination escrow has a single receiver (the maker from the source chain) and sends funds directly to that receiver whenever parts are filled.

## Key Features

### 🎯 **Single Receiver Model**
- **Receiver Address**: The unique receiver (maker from source chain) who receives all funds
- **Taker Address**: The single taker who deploys the escrow (no multiple takers needed)
- **Direct Transfers**: All withdrawal operations send funds directly to the receiver address

### 🔐 **N+1 Merkle Secrets System**
- **N Parts**: Configurable number of equal parts (e.g., 4 parts = 25% each)
- **N+1 Secrets**: Total number of secrets (N parts + 1 completion secret)
- **Cumulative Filling**: Each secret can fill up to its cumulative limit
- **Merkle Proofs**: Simplified Merkle proof verification for secret validation

### ⏰ **Time Windows**
- **DST_WITHDRAWAL**: Only the taker who created the escrow can withdraw
- **DST_PUBLIC_WITHDRAWAL**: Anyone can withdraw, but funds go to receiver
- **DST_CANCELLATION**: Anyone can refund to the taker who created the escrow

### 🛡️ **Security Features**
- **Nullifier Tracking**: Global nullifier system prevents double-spending
- **Deadline Protection**: Transaction execution deadlines prevent replay attacks
- **Hash Verification**: keccak256 hash verification for secrets

## Usage Pattern

### 1. **Escrow Creation**
```move
// Taker creates destination escrow with receiver_address (maker from source chain)
create_and_transfer_escrow(
    factory,
    taker_coins,
    hash_lock,
    merkle_root,
    receiver_address,  // Maker from source chain
    time_windows,
    num_parts,
    deadline,
    clock,
    ctx
)
```

### 2. **Partial Withdrawal**
```move
// Anyone with valid secret can withdraw, but funds go to receiver_address
withdraw_partial(
    escrow,
    factory,
    secret,
    merkle_proof,
    secret_index,
    desired_amount,
    clock,
    ctx
)
```

### 3. **Full Withdrawal**
```move
// Complete the escrow with completion secret
withdraw_full(
    escrow,
    factory,
    secret,
    merkle_proof,
    secret_index,
    clock,
    ctx
)
```

### 4. **Refund**
```move
// Anyone can refund to taker in cancellation window
anyone_refund_to_taker(
    escrow,
    clock,
    ctx
)
```

## Key Differences from Source Escrow

| Feature | Source Escrow | Destination Escrow |
|---------|---------------|-------------------|
| **Takers** | Multiple takers with assigned secrets | Single taker who deploys escrow |
| **Receiver** | Funds go to assigned taker per secret | All funds go to single receiver |
| **Address Storage** | Stores array of taker addresses | Stores single receiver address |
| **Withdrawal Logic** | Funds go to specific taker | Funds always go to receiver |
| **Authorization** | Only assigned taker can withdraw | Anyone can withdraw (funds to receiver) |

## Contract Structure

### **Escrow Object**
```move
public struct Escrow has key, store {
    id: object::UID,
    balance: Balance<SUI>,
    deposit_fee: Balance<SUI>,
    hash_lock: vector<u8>,
    merkle_root: vector<u8>,
    maker_address: address,        // Taker who created escrow
    receiver_address: address,     // Receiver (maker from source chain)
    // ... time windows, parts, etc.
}
```

### **Factory Object**
```move
public struct EscrowFactory has key {
    id: object::UID,
    shared_nullifiers: Table<vector<u8>, bool>,
    escrow_count: u64,
}
```

## Error Codes

- `EESCROW_ALREADY_RESOLVED`: Escrow has already been resolved
- `EUNAUTHORIZED`: Unauthorized access attempt
- `EINVALID_HASH`: Invalid hash lock or Merkle root
- `EINVALID_AMOUNT`: Invalid amount specified
- `EINVALID_MERKLE_PROOF`: Invalid Merkle proof
- `ENULLIFIER_ALREADY_USED`: Secret has already been used
- `EINVALID_FILL_AMOUNT`: Invalid fill amount
- `EWINDOW_EXPIRED`: Time window has expired
- `EWINDOW_NOT_ACTIVE`: Time window is not active
- `EINVALID_PERMIT`: Invalid permit or timing
- `EDEADLINE_EXPIRED`: Transaction deadline has expired
- `EINVALID_NUM_PARTS`: Invalid number of parts
- `EINVALID_SECRET_INDEX`: Invalid secret index

## View Functions

- `get_escrow_info()`: Get complete escrow information
- `get_receiver_address()`: Get the receiver address
- `get_taker_address()`: Get the taker who created the escrow
- `get_num_parts()`: Get number of parts
- `get_num_secrets()`: Get total number of secrets (N+1)
- `get_fill_percentage()`: Get completion percentage
- `check_current_window()`: Check current time window
- `is_nullifier_used()`: Check if nullifier is used

## Cross-Chain Integration

This destination escrow is designed to work with the source escrow on another chain:

1. **Source Chain**: Maker creates escrow with multiple takers
2. **Destination Chain**: Taker creates destination escrow with receiver (maker from source)
3. **Secrets**: Same secrets work on both chains
4. **Funds Flow**: Source → Destination → Receiver (maker from source)

The destination escrow ensures that the original maker from the source chain receives the funds, maintaining the cross-chain HTLC integrity. 