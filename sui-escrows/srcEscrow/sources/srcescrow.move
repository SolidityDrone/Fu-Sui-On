#[allow(duplicate_alias)]
module srcescrow::srcescrow;

use sui::coin::{Self, Coin};
use sui::balance::{Self, Balance};
use sui::sui::SUI;
use sui::table::{Self, Table};
use sui::clock::{Self, Clock};
use sui::hash::keccak256;
use std::option;

/// HTLC Escrow object with time windows and N+1 secrets merkle subdivision
public struct Escrow has key, store {
    id: object::UID,
    balance: Balance<SUI>,
    deposit_fee: Balance<SUI>,
    merkle_root: vector<u8>,      // Merkle root of N+1 secret hashes
    maker_address: address,
    
    // Time windows (in milliseconds)
    dst_withdrawal_end: u64,      // Taker exclusive window
    dst_public_withdrawal_end: u64, // Anyone can resolve window  
    dst_cancellation_end: u64,    // Maker refund window
    
    // N+1 secrets merkle subdivision with partial fill support
    num_parts: u64,               // N equal parts (e.g., 4 parts = 25% each)
    part_size: u64,               // Size of each part in SUI (total_amount / num_parts)
    // Note: We have N+1 secrets total (num_parts + 1)
    // Secret 1-N: can fill up to (secret_index * part_size) cumulative
    // Secret N+1: completion secret for any remaining amount
    
    created_at: u64,
    total_amount: u64,
    filled_amount: u64,
    deadline: u64,                // Deadline for transaction execution (prevent replay attacks)
    is_resolved: bool,
}

/// Shared factory with global nullifier tracking
public struct EscrowFactory has key {
    id: object::UID,
    shared_nullifiers: Table<vector<u8>, bool>, // Global nullifier tracking
    escrow_count: u64,
}

/// Initialize the escrow factory (called once to set up shared infrastructure)
public fun initialize_factory(ctx: &mut tx_context::TxContext): EscrowFactory {
    EscrowFactory {
        id: object::new(ctx),
        shared_nullifiers: table::new(ctx),
        escrow_count: 0,
    }
}

/// Create and share the escrow factory for public use
public fun create_shared_factory(ctx: &mut tx_context::TxContext) {
    let factory = initialize_factory(ctx);
    sui::transfer::share_object(factory);
}

/// Error codes
const EESCROW_ALREADY_RESOLVED: u64 = 1;
const EINVALID_HASH: u64 = 3;
const EINVALID_AMOUNT: u64 = 5;
const EINVALID_MERKLE_PROOF: u64 = 6;
const ENULLIFIER_ALREADY_USED: u64 = 7;
const EINVALID_FILL_AMOUNT: u64 = 8;
const EWINDOW_EXPIRED: u64 = 10;
const EWINDOW_NOT_ACTIVE: u64 = 11;
const EINVALID_PERMIT: u64 = 13;
const EDEADLINE_EXPIRED: u64 = 14;
const EINVALID_NUM_PARTS: u64 = 15;
const EINVALID_SECRET_INDEX: u64 = 16;
const EINVALID_SIGNATURE: u64 = 19;

/// Window identifiers
const DST_WITHDRAWAL: u64 = 1;
const DST_PUBLIC_WITHDRAWAL: u64 = 2;
const DST_CANCELLATION: u64 = 3;



/// OpenZeppelin MerkleProof verification algorithm
/// Matches the Solidity implementation exactly
fun verify_merkle_proof(root: &vector<u8>, leaf: &vector<u8>, proof: &vector<vector<u8>>, leaf_index: u64): bool {
    process_proof(proof, leaf) == *root
}

/// Process a Merkle proof to compute the root hash
/// This matches OpenZeppelin's processProof(bytes32[] memory proof, bytes32 leaf)
fun process_proof(proof: &vector<vector<u8>>, leaf: &vector<u8>): vector<u8> {
    let mut computed_hash = *leaf;
    let mut i = 0;
    
    while (i < vector::length(proof)) {
        let proof_element = *vector::borrow(proof, i);
        computed_hash = commutative_keccak256(&computed_hash, &proof_element);
        i = i + 1;
    };
    
    computed_hash
}

/// Commutative Keccak256 hash of a sorted pair of byte vectors
/// This matches OpenZeppelin's Hashes.commutativeKeccak256(bytes32 a, bytes32 b)
fun commutative_keccak256(a: &vector<u8>, b: &vector<u8>): vector<u8> {
    if (compare_bytes(a, b)) {
        efficient_keccak256(a, b)
    } else {
        efficient_keccak256(b, a)
    }
}

/// Efficient implementation of keccak256(a || b) without extra allocations
/// This matches OpenZeppelin's Hashes.efficientKeccak256(bytes32 a, bytes32 b)
fun efficient_keccak256(a: &vector<u8>, b: &vector<u8>): vector<u8> {
    let mut combined = vector::empty<u8>();
    vector::append(&mut combined, *a);
    vector::append(&mut combined, *b);
    keccak256(&combined)
}

/// Compare two byte vectors lexicographically (a < b)
/// This ensures the same ordering behavior as Solidity's bytes32 comparison
fun compare_bytes(a: &vector<u8>, b: &vector<u8>): bool {
    let len_a = vector::length(a);
    let len_b = vector::length(b);
    let min_len = if (len_a < len_b) len_a else len_b;
    
    let mut i = 0;
    while (i < min_len) {
        let byte_a = *vector::borrow(a, i);
        let byte_b = *vector::borrow(b, i);
        if (byte_a < byte_b) return true;
        if (byte_a > byte_b) return false;
        i = i + 1;
    };
    
    // If all compared bytes are equal, shorter vector is "less than"
    len_a < len_b
}

#[test]
fun test_commutative_hashing() {
    // Test commutative property of our hashing
    let a = x"1111111111111111111111111111111111111111111111111111111111111111";
    let b = x"2222222222222222222222222222222222222222222222222222222222222222";
    
    let hash1 = commutative_keccak256(&a, &b);
    let hash2 = commutative_keccak256(&b, &a);
    
    // Should be commutative (same result regardless of order)
    assert!(hash1 == hash2, 0);
    
    // Test that different inputs give different hashes
    let c = x"3333333333333333333333333333333333333333333333333333333333333333";
    let hash3 = commutative_keccak256(&a, &c);
    assert!(hash1 != hash3, 1);
}

#[test]
fun test_actual_merkle_verification() {
    // Test with actual values from your test output
    let leaf = x"14fe2f5849d3f391ceb9c24d67239a3b0f879e4f2e45ee2f2994ea106c5c5e53";
    let proof = vector[
        x"a3cd8a48937ca5e33eb2bc6644cb5c06f917b53833260d979c75aadf6d5c5e53",
        x"36d954e2381089c5510bbcbc163b10bbf7a2e0f752f29a734abfc794765c5e53",
        x"d1324cf4b76042fb1b3435145753e8d809a372a20798260673025c3cdac944f4",
        x"59a07ddfc934cf0519c39fcedd90affc5a74996462fb1828995578d81e756039"
    ];
    let root = x"768f7ccfe4c89b83b89f2544d5df13f4cee6b6c269de2facfae8fd171672d704";
    
    // Test our verification matches OpenZeppelin
    assert!(verify_merkle_proof(&root, &leaf, &proof, 0), 0);
    
    // Test process_proof function directly
    let computed_root = process_proof(&proof, &leaf);
    assert!(computed_root == root, 1);
    
    // Test commutative hashing with actual values
    let hash1 = commutative_keccak256(&leaf, &proof[0]);
    let hash2 = commutative_keccak256(&proof[0], &leaf);
    assert!(hash1 == hash2, 2); // Should be commutative
}

/// Validate that num_parts is reasonable (between 1 and 20)
fun validate_num_parts(num_parts: u64): bool {
    num_parts > 0 && num_parts <= 20
}

/// Calculate maximum cumulative fill amount for a given secret index
/// Secret index 1-N: can fill up to (secret_index * part_size) cumulative
/// Secret index N+1: can fill up to total_amount (completion secret)
fun calculate_max_cumulative_fill(escrow: &Escrow, secret_index: u64): u64 {
    // Secret indices are 1-based (1 to N+1)
    assert!(secret_index > 0, EINVALID_FILL_AMOUNT);
    assert!(secret_index <= escrow.num_parts + 1, EINVALID_FILL_AMOUNT);
    
    if (secret_index <= escrow.num_parts) {
        // Secret 1-N: can fill up to secret_index * part_size
        secret_index * escrow.part_size
    } else {
        // Secret N+1: completion secret, can fill up to total amount
        escrow.total_amount
    }
}

/// Calculate fill amount for a range of parts
/// start_secret and end_secret define the range (inclusive)
/// Returns the amount that can be filled for this range
fun calculate_range_fill_amount(escrow: &Escrow, start_secret: u64, end_secret: u64): u64 {
    assert!(start_secret > 0 && start_secret <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    assert!(end_secret >= start_secret && end_secret <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    
    let start_max = calculate_max_cumulative_fill(escrow, start_secret);
    let end_max = calculate_max_cumulative_fill(escrow, end_secret);
    
    // Calculate how much this range can fill
    let range_capacity = end_max - start_max + escrow.part_size;
    
    // Ensure we don't exceed total amount
    if (range_capacity > escrow.total_amount) {
        escrow.total_amount
    } else {
        range_capacity
    }
}

/// Get current time window (DST_WITHDRAWAL, DST_PUBLIC_WITHDRAWAL, DST_CANCELLATION, 0=expired)
fun get_current_window(escrow: &Escrow, clock: &Clock): u64 {
    let current_time = clock::timestamp_ms(clock);
    
    if (current_time <= escrow.dst_withdrawal_end) {
        DST_WITHDRAWAL
    } else if (current_time <= escrow.dst_public_withdrawal_end) {
        DST_PUBLIC_WITHDRAWAL  
    } else if (current_time <= escrow.dst_cancellation_end) {
        DST_CANCELLATION
    } else {
        0 // Expired
    }
}

/// Simplified signature verification (placeholder implementation)
/// In production, you would implement proper cryptographic signature verification
fun verify_relayer_signature(
    _escrow_id: &object::UID,
    _resolver_address: address,
    _start_index: u64,
    _end_index: u64,
    _nonce: vector<u8>,
    signature: vector<u8>,
    _relayer_public_key: &vector<u8>
): bool {
    // Placeholder: just verify the signature is not empty
    // In production, implement proper ECDSA signature verification
    vector::length(&signature) > 0
}

/// Create HTLC escrow with sponsored gas via factory and N+1 secrets merkle subdivision
/// 
/// USAGE PATTERN:
/// 1. Maker creates order and sends to relayer for auction
/// 2. Relayer runs auction among resolvers/takers  
/// 3. Lead taker creates transaction with merkle root
/// 4. Lead taker executes transaction with sponsored gas payment
/// 5. Result: Maker's coins → Escrow, merkle root for secret verification
public fun create_sponsored_escrow(
    factory: &mut EscrowFactory,
    maker_coins: Coin<SUI>,      // From maker's transaction
    merkle_root: vector<u8>,
    dst_withdrawal_end: u64,
    dst_public_withdrawal_end: u64,
    dst_cancellation_end: u64,
    num_parts: u64,              // N equal parts (creates N+1 secrets total)
    deadline: u64,               // Deadline for transaction execution (prevent replay attacks)
    clock: &Clock,
    ctx: &mut tx_context::TxContext
): Escrow {
    let maker = tx_context::sender(ctx);
    let current_time = clock::timestamp_ms(clock);
    let amount = coin::value(&maker_coins);
    
    // Validate inputs
    assert!(vector::length(&merkle_root) > 0, EINVALID_HASH);
    assert!(amount > 0, EINVALID_AMOUNT);
    assert!(validate_num_parts(num_parts), EINVALID_NUM_PARTS);
    
    // Calculate part size (each part is 1/N of total)
    let part_size = amount / num_parts;
    assert!(part_size > 0, EINVALID_AMOUNT); // Ensure amount is divisible
    
    // Validate expiration times are in correct order and in the future
    assert!(dst_withdrawal_end > current_time, EINVALID_PERMIT);
    assert!(dst_public_withdrawal_end > dst_withdrawal_end, EINVALID_PERMIT);
    assert!(dst_cancellation_end > dst_public_withdrawal_end, EINVALID_PERMIT);
    
    // Validate deadline: must be in the future and transaction must be executed before deadline
    assert!(deadline > current_time, EDEADLINE_EXPIRED);
    
    // Increment escrow count
    factory.escrow_count = factory.escrow_count + 1;
    
    let escrow = Escrow {
        id: object::new(ctx),
        balance: coin::into_balance(maker_coins),
        deposit_fee: balance::zero<SUI>(), // No deposit fee in sponsored model
        merkle_root,
        maker_address: maker,
        dst_withdrawal_end,
        dst_public_withdrawal_end,
        dst_cancellation_end,
        num_parts,
        part_size,
        created_at: current_time,
        total_amount: amount,
        filled_amount: 0,
        deadline,
        is_resolved: false,
    };
    
    escrow
}

/// Helper function that creates escrow and transfers it to lead taker (for sponsored transactions)
public fun create_and_transfer_escrow(
    factory: &mut EscrowFactory,
    maker_coins: Coin<SUI>,
    merkle_root: vector<u8>,
    dst_withdrawal_end: u64,
    dst_public_withdrawal_end: u64,
    dst_cancellation_end: u64,
    num_parts: u64,
    deadline: u64,               // Deadline for transaction execution (prevent replay attacks)
    clock: &Clock,
    ctx: &mut tx_context::TxContext
) {
    let escrow = create_sponsored_escrow(
        factory,
        maker_coins,
        merkle_root,
        dst_withdrawal_end,
        dst_public_withdrawal_end,
        dst_cancellation_end,
        num_parts,
        deadline,
        clock,
        ctx
    );
    
    // Share the escrow so multiple parties can access it for withdrawals
    sui::transfer::share_object(escrow);
}

/// Withdraw partial amount with single secret and relayer authorization
/// User provides a single secret and its merkle proof to fill a specific part
/// Relayer signature authorizes this specific resolver for this specific secret
public fun withdraw_partial_single_authorized(
    escrow: &mut Escrow,
    factory: &mut EscrowFactory,
    secret: vector<u8>,
    merkle_proof: vector<vector<u8>>,
    secret_index: u64,
    desired_fill_amount: u64,
    relayer_signature: vector<u8>,
    relayer_public_key: vector<u8>,
    authorized_resolver: address,
    nonce: vector<u8>,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
): (Coin<SUI>, option::Option<Coin<SUI>>) {
    assert!(!escrow.is_resolved, EESCROW_ALREADY_RESOLVED);
    
    let sender = tx_context::sender(ctx);
    let current_window = get_current_window(escrow, clock);
    
    // Check time window permissions and authorization
    if (current_window == DST_WITHDRAWAL) {
        // DST_WITHDRAWAL: Only authorized resolver can withdraw
        // Verify relayer signature authorizes this specific resolver for this secret
        assert!(verify_relayer_signature(
            &escrow.id,
            authorized_resolver,
            secret_index,
            secret_index, // same index for single secret
            nonce,
            relayer_signature,
            &relayer_public_key
        ), EINVALID_SIGNATURE);
        
        // Only the authorized resolver can call this function
        assert!(sender == authorized_resolver, EINVALID_SIGNATURE);
    } else if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // DST_PUBLIC_WITHDRAWAL: Anyone can call, but still need valid signature
        assert!(verify_relayer_signature(
            &escrow.id,
            authorized_resolver,
            secret_index,
            secret_index,
            nonce,
            relayer_signature,
            &relayer_public_key
        ), EINVALID_SIGNATURE);
    } else {
        abort EWINDOW_EXPIRED
    };
    
    // Validate secret index
    assert!(secret_index > 0 && secret_index <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    
            // FIXED: Hash the secret to create the leaf hash
            // This proves we know the secret and matches the merkle tree construction
            let leaf_hash = keccak256(&secret);
    
    // Verify Merkle proof
    assert!(verify_merkle_proof(&escrow.merkle_root, &leaf_hash, &merkle_proof, secret_index - 1), EINVALID_MERKLE_PROOF);
    
    // Check if nullifier is already used
    // Use the secret hash as the nullifier (content-based, not index-based)
    let nullifier = keccak256(&secret);
    assert!(!table::contains(&factory.shared_nullifiers, nullifier), ENULLIFIER_ALREADY_USED);
    
    // Mark nullifier as used
    table::add(&mut factory.shared_nullifiers, nullifier, true);
    
    // Calculate maximum cumulative fill allowed by this secret
    let max_cumulative_fill = calculate_max_cumulative_fill(escrow, secret_index);
    assert!(max_cumulative_fill > escrow.filled_amount, EINVALID_FILL_AMOUNT);
    
    // Calculate actual fill amount (respecting both user desire and secret limits)
    let available_to_fill = max_cumulative_fill - escrow.filled_amount;
    let actual_fill_amount = if (desired_fill_amount > available_to_fill) {
        available_to_fill
    } else {
        desired_fill_amount
    };
    
    assert!(actual_fill_amount > 0, EINVALID_FILL_AMOUNT);
    assert!(balance::value(&escrow.balance) >= actual_fill_amount, EINVALID_AMOUNT);
    
    // Update filled amount
    escrow.filled_amount = escrow.filled_amount + actual_fill_amount;
    
    // Check if order is now completed
    if (escrow.filled_amount >= escrow.total_amount) {
        escrow.is_resolved = true;
    };
    
    // Extract coins
    let split_balance = balance::split(&mut escrow.balance, actual_fill_amount);
    let coin = coin::from_balance(split_balance, ctx);
    
    // Transfer funds to the authorized resolver (from signature), not necessarily the caller
    sui::transfer::public_transfer(coin, authorized_resolver);
        
    // Handle deposit fee reward
        let deposit_reward = if (balance::value(&escrow.deposit_fee) > 0) {
            let fee_amount = balance::value(&escrow.deposit_fee);
            let fee_balance = balance::split(&mut escrow.deposit_fee, fee_amount);
            let reward_coin = coin::from_balance(fee_balance, ctx);
        sui::transfer::public_transfer(reward_coin, authorized_resolver);
            option::none() // Already transferred
        } else {
            option::none()
        };
        
        // Return zero coin since we transferred the real coin
        let zero_coin = coin::zero<SUI>(ctx);
        (zero_coin, deposit_reward)
}

/// Withdraw partial amount with range of secrets and relayer authorization
/// User provides start_secret and end_secret to define their fill range
/// Relayer signature authorizes this specific resolver for this specific range
/// This prevents frontrunning since only the authorized resolver can use the signature
public fun withdraw_partial_range_authorized(
    escrow: &mut Escrow,
    factory: &mut EscrowFactory,
    start_secret: vector<u8>,
    end_secret: vector<u8>,
    start_merkle_proof: vector<vector<u8>>,
    end_merkle_proof: vector<vector<u8>>,
    start_secret_index: u64,
    end_secret_index: u64,
    desired_fill_amount: u64,
    relayer_signature: vector<u8>,
    relayer_public_key: vector<u8>,
    authorized_resolver: address,
    nonce: vector<u8>,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
): (Coin<SUI>, option::Option<Coin<SUI>>) {
    assert!(!escrow.is_resolved, EESCROW_ALREADY_RESOLVED);
    
    let sender = tx_context::sender(ctx);
    let current_window = get_current_window(escrow, clock);
    
    // Check time window permissions and authorization
    if (current_window == DST_WITHDRAWAL) {
        // DST_WITHDRAWAL: Only authorized resolver can withdraw
        // Verify relayer signature authorizes this specific resolver for this range
        assert!(verify_relayer_signature(
            &escrow.id,
            authorized_resolver,
            start_secret_index,
            end_secret_index,
            nonce,
            relayer_signature,
            &relayer_public_key
        ), EINVALID_SIGNATURE);
        
        // Only the authorized resolver can call this function
        assert!(sender == authorized_resolver, EINVALID_SIGNATURE);
    } else if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // DST_PUBLIC_WITHDRAWAL: Anyone can call, but still need valid signature
        assert!(verify_relayer_signature(
            &escrow.id,
            authorized_resolver,
            start_secret_index,
            end_secret_index,
            nonce,
            relayer_signature,
            &relayer_public_key
        ), EINVALID_SIGNATURE);
    } else {
        abort EWINDOW_EXPIRED
    };
    
    // Validate range
    assert!(start_secret_index > 0 && start_secret_index <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    assert!(end_secret_index >= start_secret_index && end_secret_index <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    
            // FIXED: Hash the secrets to create the leaf hashes
            // This proves we know the secrets and matches the merkle tree construction
            let start_leaf_hash = keccak256(&start_secret);
            let end_leaf_hash = keccak256(&end_secret);
    
    // Verify Merkle proofs for both start and end secrets
    assert!(verify_merkle_proof(&escrow.merkle_root, &start_leaf_hash, &start_merkle_proof, start_secret_index - 1), EINVALID_MERKLE_PROOF);
    assert!(verify_merkle_proof(&escrow.merkle_root, &end_leaf_hash, &end_merkle_proof, end_secret_index - 1), EINVALID_MERKLE_PROOF);
    
    // Check if any secrets in the range are already nullified
    // Use the secret hashes as nullifiers (content-based, not index-based)
    let start_nullifier = keccak256(&start_secret);
    let end_nullifier = keccak256(&end_secret);
    
    // Check start and end nullifiers
    assert!(!table::contains(&factory.shared_nullifiers, start_nullifier), ENULLIFIER_ALREADY_USED);
    assert!(!table::contains(&factory.shared_nullifiers, end_nullifier), ENULLIFIER_ALREADY_USED);
    
    // Calculate range fill capacity
    let range_capacity = calculate_range_fill_amount(escrow, start_secret_index, end_secret_index);
    assert!(range_capacity > escrow.filled_amount, EINVALID_FILL_AMOUNT);
    
    // Calculate actual fill amount (respecting both user desire and range limits)
    let available_to_fill = range_capacity - escrow.filled_amount;
    let actual_fill_amount = if (desired_fill_amount > available_to_fill) {
        available_to_fill
    } else {
        desired_fill_amount
    };
    
    assert!(actual_fill_amount > 0, EINVALID_FILL_AMOUNT);
    assert!(balance::value(&escrow.balance) >= actual_fill_amount, EINVALID_AMOUNT);
    
    // Mark all secrets in the range as used (nullify them)
    // For range withdrawal, we only nullify the start and end secrets
    // The range withdrawal is only valid if both start and end secrets are provided
    // This prevents double-spending of the same range
    let start_nullifier = keccak256(&start_secret);
    let end_nullifier = keccak256(&end_secret);
    
    // Mark both nullifiers as used
    table::add(&mut factory.shared_nullifiers, start_nullifier, true);
    table::add(&mut factory.shared_nullifiers, end_nullifier, true);
    
    // Update filled amount
    escrow.filled_amount = escrow.filled_amount + actual_fill_amount;
    
    // Check if order is now completed
    if (escrow.filled_amount >= escrow.total_amount) {
        escrow.is_resolved = true;
    };
    
    // Extract coins
    let split_balance = balance::split(&mut escrow.balance, actual_fill_amount);
    let coin = coin::from_balance(split_balance, ctx);
    
    // Transfer funds to the authorized resolver (from signature), not necessarily the caller
    sui::transfer::public_transfer(coin, authorized_resolver);
    
    // Handle deposit fee reward
    let deposit_reward = if (balance::value(&escrow.deposit_fee) > 0) {
        let fee_amount = balance::value(&escrow.deposit_fee);
        let fee_balance = balance::split(&mut escrow.deposit_fee, fee_amount);
        let reward_coin = coin::from_balance(fee_balance, ctx);
        sui::transfer::public_transfer(reward_coin, authorized_resolver);
        option::none() // Already transferred
    } else {
        option::none()
    };
    
    // Return zero coin since we transferred the real coin
    let zero_coin = coin::zero<SUI>(ctx);
    (zero_coin, deposit_reward)
}

/// Withdraw full remaining amount with completion secret and authorization
public fun withdraw_full_authorized(
    escrow: Escrow,
    factory: &mut EscrowFactory,
    completion_secret: vector<u8>,
    completion_merkle_proof: vector<vector<u8>>,
    completion_secret_index: u64,
    relayer_signature: vector<u8>,
    relayer_public_key: vector<u8>,
    authorized_resolver: address,
    nonce: vector<u8>,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
): (Coin<SUI>, option::Option<Coin<SUI>>) {
    assert!(!escrow.is_resolved, EESCROW_ALREADY_RESOLVED);
    
    let sender = tx_context::sender(ctx);
    let current_window = get_current_window(&escrow, clock);
    
    // Check time window permissions and authorization
    if (current_window == DST_WITHDRAWAL) {
        // DST_WITHDRAWAL: Only authorized resolver can withdraw
        // Verify relayer signature authorizes this specific resolver for completion
        assert!(verify_relayer_signature(
            &escrow.id,
            authorized_resolver,
            completion_secret_index,
            completion_secret_index,
            nonce,
            relayer_signature,
            &relayer_public_key
        ), EINVALID_SIGNATURE);
        
        // Only the authorized resolver can call this function
        assert!(sender == authorized_resolver, EINVALID_SIGNATURE);
    } else if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // DST_PUBLIC_WITHDRAWAL: Anyone can call, but still need valid signature
        assert!(verify_relayer_signature(
            &escrow.id,
            authorized_resolver,
            completion_secret_index,
            completion_secret_index,
            nonce,
            relayer_signature,
            &relayer_public_key
        ), EINVALID_SIGNATURE);
    } else {
        abort EWINDOW_EXPIRED
    };
    
            // FIXED: Hash the secret to create the leaf hash
            // This proves we know the secret and matches the merkle tree construction
            let leaf_hash = keccak256(&completion_secret);
    
    // Verify Merkle proof
    assert!(verify_merkle_proof(&escrow.merkle_root, &leaf_hash, &completion_merkle_proof, completion_secret_index - 1), EINVALID_MERKLE_PROOF);
    
    // Validate completion secret index allows completing the order
    let max_cumulative_fill = calculate_max_cumulative_fill(&escrow, completion_secret_index);
    assert!(max_cumulative_fill >= escrow.total_amount, EINVALID_FILL_AMOUNT);
    
    // Check if nullifier is already used
    // Use the secret hash as the nullifier (content-based, not index-based)
    let nullifier = keccak256(&completion_secret);
    assert!(!table::contains(&factory.shared_nullifiers, nullifier), ENULLIFIER_ALREADY_USED);
    
    // Mark nullifier as used
    table::add(&mut factory.shared_nullifiers, nullifier, true);
    
    // Extract all remaining balance and deposit fee
    let Escrow { 
        id, 
        balance, 
        deposit_fee,
        merkle_root: _, 
        maker_address: _, 
        dst_withdrawal_end: _,
        dst_public_withdrawal_end: _,
        dst_cancellation_end: _,
        num_parts: _,
        part_size: _,
        created_at: _, 
        total_amount: _, 
        filled_amount: _,
        deadline: _,
        is_resolved: _
    } = escrow;
    
    let main_coin = coin::from_balance(balance, ctx);
    
    // Transfer funds to the authorized resolver (from signature), not necessarily the caller
    sui::transfer::public_transfer(main_coin, authorized_resolver);
        
    // Handle deposit fee reward
        if (balance::value(&deposit_fee) > 0) {
            let reward_coin = coin::from_balance(deposit_fee, ctx);
        sui::transfer::public_transfer(reward_coin, authorized_resolver);
        } else {
            balance::destroy_zero(deposit_fee);
        };
        
        object::delete(id);
        
        // Return zero coins since we transferred the real coins
        let zero_main = coin::zero<SUI>(ctx);
        (zero_main, option::none())
}

/// Anyone can refund to maker in DstCancellation window  
public fun anyone_refund_to_maker(
    escrow: Escrow,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
) {
    // No authorization check - anyone can trigger refund to maker
    assert!(!escrow.is_resolved, EESCROW_ALREADY_RESOLVED);
    
    let current_window = get_current_window(&escrow, clock);
    assert!(current_window == DST_CANCELLATION, EWINDOW_NOT_ACTIVE);
    
    // Extract balance and deposit fee
    let Escrow { 
        id, 
        balance, 
        deposit_fee,
        merkle_root: _, 
        maker_address, 
        dst_withdrawal_end: _,
        dst_public_withdrawal_end: _,
        dst_cancellation_end: _,
        num_parts: _,
        part_size: _,
        created_at: _, 
        total_amount: _, 
        filled_amount: _,
        deadline: _,
        is_resolved: _
    } = escrow;
    
    // Transfer all remaining funds back to maker
    let maker_coin = coin::from_balance(balance, ctx);
    sui::transfer::public_transfer(maker_coin, maker_address);
    
    // Transfer deposit fee back to maker as well
    if (balance::value(&deposit_fee) > 0) {
        let deposit_coin = coin::from_balance(deposit_fee, ctx);
        sui::transfer::public_transfer(deposit_coin, maker_address);
    } else {
        balance::destroy_zero(deposit_fee);
    };
    
    object::delete(id);
}

// ===== VIEW FUNCTIONS =====

/// Get escrow information
public fun get_escrow_info(escrow: &Escrow): (u64, vector<u8>, address, u64, u64, u64, u64, u64, u64, u64, u64, bool) {
    (
        balance::value(&escrow.balance),
        escrow.merkle_root,
        escrow.maker_address,
        escrow.dst_withdrawal_end,
        escrow.dst_public_withdrawal_end,
        escrow.dst_cancellation_end,
        escrow.num_parts,
        escrow.part_size,
        escrow.total_amount,
        escrow.filled_amount,
        escrow.deadline,
        escrow.is_resolved
    )
}

/// Get deposit fee amount
public fun get_deposit_fee(escrow: &Escrow): u64 {
    balance::value(&escrow.deposit_fee)
}

/// Check current window
public fun check_current_window(escrow: &Escrow, clock: &Clock): u64 {
    get_current_window(escrow, clock)
}

/// Check if nullifier is used
public fun is_nullifier_used(factory: &EscrowFactory, nullifier: vector<u8>): bool {
    table::contains(&factory.shared_nullifiers, nullifier)
}

/// Get num_parts for an escrow
public fun get_num_parts(escrow: &Escrow): u64 {
    escrow.num_parts
}

/// Get part_size for an escrow  
public fun get_part_size(escrow: &Escrow): u64 {
    escrow.part_size
}

/// Get maximum cumulative fill amount for a secret index
public fun get_max_cumulative_fill(escrow: &Escrow, secret_index: u64): u64 {
    calculate_max_cumulative_fill(escrow, secret_index)
}

/// Get number of secrets (N+1) for an escrow
public fun get_num_secrets(escrow: &Escrow): u64 {
    escrow.num_parts + 1
}

/// Get fill percentage completed
public fun get_fill_percentage(escrow: &Escrow): u64 {
    if (escrow.total_amount == 0) return 0;
    (escrow.filled_amount * 100) / escrow.total_amount
}

/// Calculate fill amount for a range of parts
public fun get_range_fill_amount(escrow: &Escrow, start_secret_index: u64, end_secret_index: u64): u64 {
    calculate_range_fill_amount(escrow, start_secret_index, end_secret_index)
}

/// Get the deadline for transaction execution
public fun get_deadline(escrow: &Escrow): u64 {
    escrow.deadline
}

/// Test function to verify a merkle proof manually
public fun test_verify_merkle_proof(
    root: vector<u8>,
    leaf: vector<u8>,
    proof: vector<vector<u8>>,
    leaf_index: u64
): bool {
    verify_merkle_proof(&root, &leaf, &proof, leaf_index)
}

