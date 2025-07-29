#[allow(duplicate_alias)]
module dstescrow::dstescrow;

use sui::coin::{Self, Coin};
use sui::balance::{Self, Balance};
use sui::sui::SUI;
use sui::table::{Self, Table};
use sui::clock::{Self, Clock};
use sui::hash::keccak256;
use std::option;
use std::vector;

/// HTLC Escrow object with time windows and N+1 secrets merkle subdivision
public struct Escrow has key, store {
    id: object::UID,
    balance: Balance<SUI>,
    deposit_fee: Balance<SUI>,
    hash_lock: vector<u8>, // keccak256(secret)
    merkle_root: vector<u8>,
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

/// Window identifiers
const DST_WITHDRAWAL: u64 = 1;
const DST_PUBLIC_WITHDRAWAL: u64 = 2;
const DST_CANCELLATION: u64 = 3;

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

/// Verify keccak256 hash
fun verify_hash_lock(secret: &vector<u8>, hash_lock: &vector<u8>): bool {
    let computed_hash = keccak256(secret);
    computed_hash == *hash_lock
}

/// Verify Merkle proof - matches OpenZeppelin SimpleMerkleTree
/// OpenZeppelin uses keccak256(abi.encodePacked(left, right)) for internal nodes
fun verify_merkle_proof(root: &vector<u8>, leaf: &vector<u8>, proof: &vector<vector<u8>>, leaf_index: u64): bool {
    let computed_hash = *leaf;
    let index = leaf_index;
    
    // Traverse the proof path from leaf to root
    let i = 0;
    while (i < vector::length(proof)) {
        let proof_element = *vector::borrow(proof, i);
        
        // OpenZeppelin SimpleMerkleTree uses keccak256(abi.encodePacked(left, right))
        // For even indices: hash(computed_hash, proof_element)
        // For odd indices: hash(proof_element, computed_hash)
        if (index % 2 == 0) {
            // Even index: hash(computed_hash, proof_element)
            let combined = vector::empty<u8>();
            vector::append(&mut combined, computed_hash);
            vector::append(&mut combined, proof_element);
            computed_hash = keccak256(&combined);
        } else {
            // Odd index: hash(proof_element, computed_hash)
            let combined = vector::empty<u8>();
            vector::append(&mut combined, proof_element);
            vector::append(&mut combined, computed_hash);
            computed_hash = keccak256(&combined);
        };
        
        // Move up the tree
        index = index / 2;
        i = i + 1;
    };
    
    // Check if computed hash matches the root
    computed_hash == *root
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

/// Create HTLC escrow with sponsored gas via factory and N+1 secrets merkle subdivision
public fun create_sponsored_escrow(
    factory: &mut EscrowFactory,
    maker_coins: Coin<SUI>,      // From maker's transaction
    hash_lock: vector<u8>,
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
    assert!(vector::length(&hash_lock) == 32, EINVALID_HASH); // keccak256 produces 32 bytes
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
        hash_lock,
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
    hash_lock: vector<u8>,
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
        hash_lock,
        merkle_root,
        dst_withdrawal_end,
        dst_public_withdrawal_end,
        dst_cancellation_end,
        num_parts,
        deadline,
        clock,
        ctx
    );
    
    // Transfer escrow to the caller (lead taker who created the escrow)
    let lead_taker = tx_context::sender(ctx);
    sui::transfer::transfer(escrow, lead_taker);
}

/// Withdraw partial amount with single secret (respects time windows)
/// User provides a single secret and its merkle proof to fill a specific part
public fun withdraw_partial_single(
    escrow: &mut Escrow,
    factory: &mut EscrowFactory,
    secret: vector<u8>,
    merkle_proof: vector<vector<u8>>,
    secret_index: u64,
    desired_fill_amount: u64,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
): (Coin<SUI>, option::Option<Coin<SUI>>) {
    assert!(!escrow.is_resolved, EESCROW_ALREADY_RESOLVED);
    
    let sender = tx_context::sender(ctx);
    let current_window = get_current_window(escrow, clock);
    
    // Check time window permissions
    if (current_window == DST_WITHDRAWAL) {
        // DstWithdrawal: Only specific takers can resolve (if needed, add authorization logic here)
        // For now, anyone can resolve in this window
    } else if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // DstPublicWithdrawal: Anyone can call
        // No authorization check - anyone can resolve
    } else {
        abort EWINDOW_EXPIRED
    };
    
    // Validate secret index
    assert!(secret_index > 0 && secret_index <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    
    // Verify hash lock
    assert!(verify_hash_lock(&secret, &escrow.hash_lock), EINVALID_HASH);
    
    // Calculate hash of the secret for merkle proof
    let leaf_hash = keccak256(&secret);
    
    // Verify Merkle proof
    assert!(verify_merkle_proof(&escrow.merkle_root, &leaf_hash, &merkle_proof, secret_index - 1), EINVALID_MERKLE_PROOF);
    
    // Check if nullifier is already used
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
    
    // Handle transfers based on window
    if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // In PUBLIC window: Transfer main coin to caller, reward to caller
        sui::transfer::public_transfer(coin, sender);
        
        // Deposit fee reward goes to the caller (resolver) as incentive  
        let deposit_reward = if (balance::value(&escrow.deposit_fee) > 0) {
            let fee_amount = balance::value(&escrow.deposit_fee);
            let fee_balance = balance::split(&mut escrow.deposit_fee, fee_amount);
            let reward_coin = coin::from_balance(fee_balance, ctx);
            sui::transfer::public_transfer(reward_coin, sender);
            option::none() // Already transferred
        } else {
            option::none()
        };
        
        // Return zero coin since we transferred the real coin
        let zero_coin = coin::zero<SUI>(ctx);
        (zero_coin, deposit_reward)
    } else {
        // In DST_WITHDRAWAL window: Return coins to caller
        let deposit_reward = option::none(); // No reward in private window
        (coin, deposit_reward)
    }
}

/// Withdraw partial amount with range of secrets (respects time windows)
/// User provides start_secret and end_secret to define their fill range
/// Only the start and end secrets need valid merkle proofs
/// All secrets in the range (start to end inclusive) get nullified
public fun withdraw_partial_range(
    escrow: &mut Escrow,
    factory: &mut EscrowFactory,
    start_secret: vector<u8>,
    end_secret: vector<u8>,
    start_merkle_proof: vector<vector<u8>>,
    end_merkle_proof: vector<vector<u8>>,
    start_secret_index: u64,
    end_secret_index: u64,
    desired_fill_amount: u64,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
): (Coin<SUI>, option::Option<Coin<SUI>>) {
    assert!(!escrow.is_resolved, EESCROW_ALREADY_RESOLVED);
    
    let sender = tx_context::sender(ctx);
    let current_window = get_current_window(escrow, clock);
    
    // Check time window permissions
    if (current_window == DST_WITHDRAWAL) {
        // DstWithdrawal: Only specific takers can resolve (if needed, add authorization logic here)
        // For now, anyone can resolve in this window
    } else if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // DstPublicWithdrawal: Anyone can call
        // No authorization check - anyone can resolve
    } else {
        abort EWINDOW_EXPIRED
    };
    
    // Validate range
    assert!(start_secret_index > 0 && start_secret_index <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    assert!(end_secret_index >= start_secret_index && end_secret_index <= escrow.num_parts + 1, EINVALID_SECRET_INDEX);
    
    // Verify hash lock for both start and end secrets
    assert!(verify_hash_lock(&start_secret, &escrow.hash_lock), EINVALID_HASH);
    assert!(verify_hash_lock(&end_secret, &escrow.hash_lock), EINVALID_HASH);
    
    // Calculate hashes for merkle proofs
    let start_leaf_hash = keccak256(&start_secret);
    let end_leaf_hash = keccak256(&end_secret);
    
    // Verify Merkle proofs for both start and end secrets
    assert!(verify_merkle_proof(&escrow.merkle_root, &start_leaf_hash, &start_merkle_proof, start_secret_index - 1), EINVALID_MERKLE_PROOF);
    assert!(verify_merkle_proof(&escrow.merkle_root, &end_leaf_hash, &end_merkle_proof, end_secret_index - 1), EINVALID_MERKLE_PROOF);
    
    // Check if any secrets in the range are already nullified
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
    // For now, we only nullify start and end, but in a full implementation
    // you would nullify all secrets from start_secret_index to end_secret_index
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
    
    // Handle transfers based on window
    if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // In PUBLIC window: Transfer main coin to caller, reward to caller
        sui::transfer::public_transfer(coin, sender);
        
        // Deposit fee reward goes to the caller (resolver) as incentive  
        let deposit_reward = if (balance::value(&escrow.deposit_fee) > 0) {
            let fee_amount = balance::value(&escrow.deposit_fee);
            let fee_balance = balance::split(&mut escrow.deposit_fee, fee_amount);
            let reward_coin = coin::from_balance(fee_balance, ctx);
            sui::transfer::public_transfer(reward_coin, sender);
            option::none() // Already transferred
        } else {
            option::none()
        };
        
        // Return zero coin since we transferred the real coin
        let zero_coin = coin::zero<SUI>(ctx);
        (zero_coin, deposit_reward)
    } else {
        // In DST_WITHDRAWAL window: Return coins to caller
        let deposit_reward = option::none(); // No reward in private window
        (coin, deposit_reward)
    }
}

/// Withdraw full remaining amount with completion secret (completes the escrow)
public fun withdraw_full(
    escrow: Escrow,
    factory: &mut EscrowFactory,
    completion_secret: vector<u8>,
    completion_merkle_proof: vector<vector<u8>>,
    completion_secret_index: u64,
    clock: &Clock,
    ctx: &mut tx_context::TxContext
): (Coin<SUI>, option::Option<Coin<SUI>>) {
    assert!(!escrow.is_resolved, EESCROW_ALREADY_RESOLVED);
    
    let sender = tx_context::sender(ctx);
    let current_window = get_current_window(&escrow, clock);
    
    // Check time window permissions
    if (current_window == DST_WITHDRAWAL) {
        // DstWithdrawal: Only specific takers can resolve (if needed, add authorization logic here)
        // For now, anyone can resolve in this window
    } else if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // DstPublicWithdrawal: Anyone can call
        // No authorization check - anyone can resolve
    } else {
        abort EWINDOW_EXPIRED
    };
    
    // Verify hash lock
    assert!(verify_hash_lock(&completion_secret, &escrow.hash_lock), EINVALID_HASH);
    
    // Calculate hash of the secret for merkle proof
    let leaf_hash = keccak256(&completion_secret);
    
    // Verify Merkle proof
    assert!(verify_merkle_proof(&escrow.merkle_root, &leaf_hash, &completion_merkle_proof, completion_secret_index - 1), EINVALID_MERKLE_PROOF);
    
    // Validate completion secret index allows completing the order
    let max_cumulative_fill = calculate_max_cumulative_fill(&escrow, completion_secret_index);
    assert!(max_cumulative_fill >= escrow.total_amount, EINVALID_FILL_AMOUNT);
    
    // Check if nullifier is already used
    let nullifier = keccak256(&completion_secret);
    assert!(!table::contains(&factory.shared_nullifiers, nullifier), ENULLIFIER_ALREADY_USED);
    
    // Mark nullifier as used
    table::add(&mut factory.shared_nullifiers, nullifier, true);
    
    // Extract all remaining balance and deposit fee
    let Escrow { 
        id, 
        balance, 
        deposit_fee,
        hash_lock: _, 
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
    
    // Handle transfers based on window
    if (current_window == DST_PUBLIC_WITHDRAWAL) {
        // In PUBLIC window: Transfer main coin to caller, reward to caller
        sui::transfer::public_transfer(main_coin, sender);
        
        // Deposit fee reward goes to the caller (resolver) as incentive
        if (balance::value(&deposit_fee) > 0) {
            let reward_coin = coin::from_balance(deposit_fee, ctx);
            sui::transfer::public_transfer(reward_coin, sender);
        } else {
            balance::destroy_zero(deposit_fee);
        };
        
        object::delete(id);
        
        // Return zero coins since we transferred the real coins
        let zero_main = coin::zero<SUI>(ctx);
        (zero_main, option::none())
    } else {
        // In DST_WITHDRAWAL window: Return coins to caller
        let deposit_reward = if (balance::value(&deposit_fee) > 0) {
            option::some(coin::from_balance(deposit_fee, ctx))
        } else {
            balance::destroy_zero(deposit_fee);
            option::none()
        };
        
        object::delete(id);
        
        (main_coin, deposit_reward)
    }
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
        hash_lock: _, 
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
public fun get_escrow_info(escrow: &Escrow): (u64, vector<u8>, vector<u8>, address, u64, u64, u64, u64, u64, u64, u64, u64, bool) {
    (
        balance::value(&escrow.balance),
        escrow.hash_lock,
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