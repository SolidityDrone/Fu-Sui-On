import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { keccak256, toHex } from 'viem';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Your deployed contract IDs
const PACKAGE_ID = "0x543a1913d59ef4a4c1119881798540a2af3533e95b580061955b30e43e30fc70"; // Update with actual dstEscrow package ID

// Connect to testnet
const client = new SuiClient({ url: getFullnodeUrl('testnet') });

// Helper function to generate random secrets and merkle root
function generateRandomSecretsAndMerkleRoot(numParts: number) {
    console.log(`🎲 Generating ${numParts + 1} random secrets for N+1 system...`);

    // Generate N+1 random secrets (32 bytes each)
    const secrets: Uint8Array[] = [];
    const leafHashes: Uint8Array[] = [];

    for (let i = 0; i < numParts + 1; i++) {
        // Generate random 32-byte secret
        const secret = new Uint8Array(32);
        for (let j = 0; j < 32; j++) {
            secret[j] = Math.floor(Math.random() * 256);
        }
        secrets.push(secret);

        // Calculate keccak256 hash of the secret
        const hash = keccak256(secret);
        // Convert hex string to Uint8Array
        const hashBytes = new Uint8Array(hash.slice(2).match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
        leafHashes.push(hashBytes);

        console.log(`   Secret ${i + 1}: ${toHex(secret)}`);
        console.log(`   Hash ${i + 1}:   ${hash}`);
    }

    // For simplicity, use first leaf hash as merkle root (single level tree)
    // In production, you'd build a proper merkle tree
    const merkleRoot = leafHashes[0];
    console.log(`🌳 Merkle Root: ${toHex(merkleRoot)}`);

    return {
        secrets,
        leafHashes,
        merkleRoot,
        // For demo, we'll use the first secret/hash
        primarySecret: secrets[0],
        primaryHash: leafHashes[0]
    };
}

// Helper to convert Uint8Array to number array for Sui
function uint8ArrayToNumberArray(uint8Array: Uint8Array): number[] {
    return Array.from(uint8Array);
}

async function createDestinationEscrow(
    takerKeypair: Ed25519Keypair,
    receiverAddress: string,
    factoryId: string,
    factoryVersion: number,
    escrowNumber: number,
    secretData: any
): Promise<string | null> {
    const takerAddress = takerKeypair.toSuiAddress();

    console.log(`\n🔸 CREATING DESTINATION ESCROW ${escrowNumber}`);
    console.log("=".repeat(40));

    // Check Taker's coins
    const takerCoins = await client.getCoins({
        owner: takerAddress,
        coinType: '0x2::sui::SUI'
    });

    if (takerCoins.data.length === 0) {
        throw new Error("Taker has no SUI coins");
    }

    const takerCoin = takerCoins.data[0];
    console.log(`Taker coin: ${takerCoin.coinObjectId} (${takerCoin.balance} MIST)`);

    // Create transaction
    const tx = new Transaction();

    // Calculate time windows
    const currentTime = Date.now();
    const dstWithdrawalEnd = currentTime + 600000;      // +10 minutes 
    const dstPublicWithdrawalEnd = currentTime + 900000;  // +15 minutes
    const dstCancellationEnd = currentTime + 1200000;     // +20 minutes

    // Calculate deadline for transaction execution (prevent replay attacks)
    const deadline = currentTime + 600000; // +10 minutes

    // Use the hash of Secret 2 for 50% withdrawal
    const hashLock = uint8ArrayToNumberArray(secretData.leafHashes[1]); // Hash of Secret 2
    const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);

    const numParts = 4;
    const escrowAmount = 1000000; // 0.001 SUI (1M MIST) - taker's contribution

    console.log(`Escrow amount: ${escrowAmount} MIST (${escrowAmount / 1000000000} SUI)`);
    console.log(`Receiver address: ${receiverAddress}`);
    console.log(`Using hash of Secret 2 for 50% withdrawal: ${toHex(secretData.leafHashes[1])}`);
    console.log(`Transaction deadline: ${new Date(deadline).toISOString()} (${deadline - currentTime}ms from now)`);

    const [splitCoin] = tx.splitCoins(tx.object(takerCoin.coinObjectId), [escrowAmount]);

    // Create destination escrow with single receiver
    tx.moveCall({
        target: `${PACKAGE_ID}::dstescrow::create_and_transfer_escrow`,
        arguments: [
            tx.sharedObjectRef({              // Factory object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            splitCoin,                        // Taker's coins  
            tx.pure.vector('u8', hashLock),   // hash_lock
            tx.pure.vector('u8', merkleRoot), // merkle_root
            tx.pure.address(receiverAddress), // receiver_address (maker from source chain)
            tx.pure.u64(dstWithdrawalEnd),     // dst_withdrawal_end
            tx.pure.u64(dstPublicWithdrawalEnd), // dst_public_withdrawal_end  
            tx.pure.u64(dstCancellationEnd),   // dst_cancellation_end
            tx.pure.u64(numParts),             // num_parts (N=4 → 5 secrets)
            tx.pure.u64(deadline),             // deadline for transaction execution
            tx.object('0x6'),                  // clock
        ],
    });

    // Execute transaction
    const result = await client.signAndExecuteTransaction({
        signer: takerKeypair,
        transaction: tx,
        options: {
            showEffects: true,
            showEvents: true,
            showObjectChanges: true,
            showBalanceChanges: true,
        },
    });

    console.log(`✅ Transaction executed: ${result.digest}`);
    console.log(`✅ Status: ${result.effects?.status?.status}`);

    // Check for creation failure
    if (result.effects?.status?.status !== 'success') {
        console.log(`❌ ESCROW CREATION FAILED!`);
        console.log(`Error details:`, JSON.stringify(result.effects?.status, null, 2));
        return null;
    }

    // Extract created escrow object
    const createdObjects = result.objectChanges?.filter(
        change => change.type === 'created' &&
            change.objectType?.includes('::dstescrow::Escrow')
    );

    if (createdObjects && createdObjects.length > 0 && createdObjects[0].type === 'created') {
        const escrowId = createdObjects[0].objectId;
        console.log(`✅ Destination escrow created: ${escrowId}`);
        return escrowId;
    } else {
        console.log("❌ No escrow object found in transaction result");
        return null;
    }
}

// Test withdrawal functions
async function testWithdrawals(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    receiverAddress: string
): Promise<void> {
    console.log(`\n🎯 TESTING WITHDRAWALS FROM DESTINATION ESCROW: ${escrowId}`);
    console.log("=".repeat(70));

    // Wait for escrow to be indexed
    console.log("⏳ Waiting 3 seconds for escrow indexing...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Test partial withdrawal - funds go to receiver_address
    await testPartialWithdrawal(escrowId, factoryId, factoryVersion, secretData, receiverAddress);

    // Test full withdrawal - funds go to receiver_address
    await testFullWithdrawal(escrowId, factoryId, factoryVersion, secretData, receiverAddress);
}

async function testPartialWithdrawal(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    receiverAddress: string
): Promise<void> {
    console.log(`\n🤝 TESTING PARTIAL WITHDRAWAL (50%)`);
    console.log("─".repeat(40));

    // Get escrow data to calculate proper amounts
    const escrowData = await client.getObject({
        id: escrowId,
        options: { showContent: true }
    });

    if (!escrowData.data?.content || !('fields' in escrowData.data.content)) {
        throw new Error("Could not get escrow data");
    }

    const fields = escrowData.data.content.fields as any;
    const totalAmount = parseInt(fields.total_amount);
    const numParts = parseInt(fields.num_parts);
    const partSize = totalAmount / numParts; // Each part size

    const withdrawTx = new Transaction();

    // Use secret 2 (index 2) to withdraw up to 50%
    const secret2 = uint8ArrayToNumberArray(secretData.secrets[1]); // secret 2 (1-indexed)  
    const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);

    const secretIndex = 2; // Secret 2 allows up to 50%
    const desiredFillAmount = 2 * partSize; // 2 * part_size = 50% of total

    console.log(`   Escrow total: ${totalAmount} MIST, ${numParts} parts, part size: ${partSize} MIST`);
    console.log(`   Secret 2: ${toHex(secretData.secrets[1])}`);
    console.log(`   Withdrawing: ${desiredFillAmount} MIST (50% of escrow)`);
    console.log(`   Funds will go to receiver: ${receiverAddress}`);

    const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
        target: `${PACKAGE_ID}::dstescrow::withdraw_partial`,
        arguments: [
            withdrawTx.object(escrowId),
            withdrawTx.sharedObjectRef({              // Factory object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            withdrawTx.pure.vector('u8', secret2),
            withdrawTx.pure('vector<vector<u8>>', [merkleRoot]),
            withdrawTx.pure.u64(secretIndex),
            withdrawTx.pure.u64(desiredFillAmount),
            withdrawTx.object('0x6'),
        ],
    });

    // In destination escrow, funds automatically go to receiver_address
    // We don't need to transfer them manually
    withdrawTx.moveCall({
        target: '0x1::option::destroy_none',
        typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
        arguments: [optionalReward]
    });

    // Use a dummy keypair for testing (since anyone can call this)
    const dummyKeypair = Ed25519Keypair.generate();
    withdrawTx.setSender(dummyKeypair.toSuiAddress());
    withdrawTx.setGasBudget(15000000);

    const result = await client.signAndExecuteTransaction({
        signer: dummyKeypair,
        transaction: withdrawTx,
        options: {
            showEffects: true,
            showObjectChanges: true,
            showBalanceChanges: true
        },
    });

    console.log(`   Transaction: ${result.digest}`);
    console.log(`   Status: ${result.effects?.status?.status}`);

    if (result.effects?.status?.status !== 'success') {
        console.log(`   ❌ WITHDRAWAL FAILED!`);
        console.log(`   Error details:`, JSON.stringify(result.effects?.status, null, 2));
        return;
    }

    // Show balance changes
    if (result.balanceChanges && result.balanceChanges.length > 0) {
        console.log(`   💰 Balance changes:`);
        result.balanceChanges.forEach((change: any) => {
            console.log(`      ${change.owner}: ${change.amount} MIST`);
        });
    }

    console.log(`   ✅ Partial withdrawal successful! Funds sent to receiver.`);
    await new Promise(resolve => setTimeout(resolve, 2000));
}

async function testFullWithdrawal(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    receiverAddress: string
): Promise<void> {
    console.log(`\n🎯 TESTING FULL WITHDRAWAL (100%)`);
    console.log("─".repeat(40));

    const withdrawTx = new Transaction();

    // Use secret 5 (completion secret) to withdraw remaining funds
    const secret5 = uint8ArrayToNumberArray(secretData.secrets[4]); // secret 5 (completion)
    const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);

    const secretIndex = 5; // Secret 5 allows full withdrawal

    console.log(`   Secret 5 (completion): ${toHex(secretData.secrets[4])}`);
    console.log(`   Withdrawing remaining funds`);
    console.log(`   Funds will go to receiver: ${receiverAddress}`);

    const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
        target: `${PACKAGE_ID}::dstescrow::withdraw_full`,
        arguments: [
            withdrawTx.object(escrowId),
            withdrawTx.sharedObjectRef({              // Factory object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            withdrawTx.pure.vector('u8', secret5),
            withdrawTx.pure('vector<vector<u8>>', [merkleRoot]),
            withdrawTx.pure.u64(secretIndex),
            withdrawTx.object('0x6'),
        ],
    });

    // In destination escrow, funds automatically go to receiver_address
    withdrawTx.moveCall({
        target: '0x1::option::destroy_none',
        typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
        arguments: [optionalReward]
    });

    // Use a dummy keypair for testing (since anyone can call this)
    const dummyKeypair = Ed25519Keypair.generate();
    withdrawTx.setSender(dummyKeypair.toSuiAddress());
    withdrawTx.setGasBudget(15000000);

    const result = await client.signAndExecuteTransaction({
        signer: dummyKeypair,
        transaction: withdrawTx,
        options: {
            showEffects: true,
            showObjectChanges: true,
            showBalanceChanges: true
        },
    });

    console.log(`   Transaction: ${result.digest}`);
    console.log(`   Status: ${result.effects?.status?.status}`);

    if (result.effects?.status?.status !== 'success') {
        console.log(`   ❌ WITHDRAWAL FAILED!`);
        console.log(`   Error details:`, JSON.stringify(result.effects?.status, null, 2));
        return;
    }

    // Show balance changes
    if (result.balanceChanges && result.balanceChanges.length > 0) {
        console.log(`   💰 Balance changes:`);
        result.balanceChanges.forEach((change: any) => {
            console.log(`      ${change.owner}: ${change.amount} MIST`);
        });
    }

    console.log(`   ✅ Full withdrawal successful! Escrow completed.`);
}

async function demonstrateDestinationEscrow() {
    console.log("\n🎯 DESTINATION ESCROW WITH SINGLE RECEIVER");
    console.log("==========================================");
    console.log("Features: Single receiver model + N+1 secrets + Direct fund transfers");
    console.log("");

    // === PRIVATE KEYS FROM .ENV ===
    const TAKER_PRIVATE_KEY = (process as any).env.TAKER_PRIVATE_KEY; // Taker who deploys escrow
    const RECEIVER_PRIVATE_KEY = (process as any).env.RECEIVER_PRIVATE_KEY; // Receiver (maker from source chain)

    // Validate environment variables
    if (!TAKER_PRIVATE_KEY || !RECEIVER_PRIVATE_KEY) {
        throw new Error('Missing private keys in .env file. Please check TAKER_PRIVATE_KEY, RECEIVER_PRIVATE_KEY');
    }

    if (!PACKAGE_ID) {
        throw new Error('Missing PACKAGE_ID in .env file. Please add PACKAGE_ID to your .env file');
    }

    console.log(`📦 Using PACKAGE_ID: ${PACKAGE_ID}`);

    // Import keypairs
    const takerKeypair = Ed25519Keypair.fromSecretKey(TAKER_PRIVATE_KEY);
    const receiverKeypair = Ed25519Keypair.fromSecretKey(RECEIVER_PRIVATE_KEY);

    // Get addresses
    const takerAddress = takerKeypair.toSuiAddress();
    const receiverAddress = receiverKeypair.toSuiAddress();

    console.log(`🤝 Taker (deploys escrow): ${takerAddress}`);
    console.log(`👑 Receiver (gets all funds): ${receiverAddress}`);
    console.log("");

    // Track initial balances
    const initialTakerBalance = await client.getBalance({ owner: takerAddress, coinType: '0x2::sui::SUI' });
    const initialReceiverBalance = await client.getBalance({ owner: receiverAddress, coinType: '0x2::sui::SUI' });

    console.log("💰 INITIAL BALANCES:");
    console.log(`🤝 Taker: ${parseInt(initialTakerBalance.totalBalance)} MIST (${parseInt(initialTakerBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`👑 Receiver: ${parseInt(initialReceiverBalance.totalBalance)} MIST (${parseInt(initialReceiverBalance.totalBalance) / 1000000000} SUI)`);
    console.log("");

    // Use the factory (you'll need to create this first)
    const factoryId = "0x2948c6d0fef0b0f2c60bec03a84750e31d5a6799711044db6b0346af0ade3b03"; // Update with actual factory ID
    const factoryVersion = 513761148; // Update with actual factory version
    console.log(`🏭 Using factory: ${factoryId}`);
    console.log(`🏭 Factory version: ${factoryVersion}`);
    console.log("");

    // CREATE DESTINATION ESCROW
    console.log(`🏭 CREATING DESTINATION ESCROW:`);
    console.log("=".repeat(40));

    // Generate random secrets and merkle root for this escrow
    const secretData = generateRandomSecretsAndMerkleRoot(4); // 4 parts = 5 secrets

    // Create destination escrow
    const escrowId = await createDestinationEscrow(
        takerKeypair,
        receiverAddress,
        factoryId,
        factoryVersion,
        1,
        secretData
    );

    if (!escrowId) {
        console.log("❌ Failed to create destination escrow");
        return;
    }

    console.log(`\n✅ Destination escrow created: ${escrowId}`);

    // TEST WITHDRAWALS
    await testWithdrawals(escrowId, factoryId, factoryVersion, secretData, receiverAddress);

    // FINAL BALANCE TRACKING
    console.log("\n💰 FINAL BALANCE COMPARISON:");
    console.log("===============================");

    const finalTakerBalance = await client.getBalance({ owner: takerAddress, coinType: '0x2::sui::SUI' });
    const finalReceiverBalance = await client.getBalance({ owner: receiverAddress, coinType: '0x2::sui::SUI' });

    const takerChange = parseInt(finalTakerBalance.totalBalance) - parseInt(initialTakerBalance.totalBalance);
    const receiverChange = parseInt(finalReceiverBalance.totalBalance) - parseInt(initialReceiverBalance.totalBalance);

    console.log(`🤝 Taker (deployed escrow):`);
    console.log(`   Initial: ${parseInt(initialTakerBalance.totalBalance)} MIST (${parseInt(initialTakerBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Final:   ${parseInt(finalTakerBalance.totalBalance)} MIST (${parseInt(finalTakerBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Change:  ${takerChange > 0 ? '+' : ''}${takerChange} MIST (${takerChange / 1000000000} SUI)`);
    console.log("");
    console.log(`👑 Receiver (got all funds):`);
    console.log(`   Initial: ${parseInt(initialReceiverBalance.totalBalance)} MIST (${parseInt(initialReceiverBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Final:   ${parseInt(finalReceiverBalance.totalBalance)} MIST (${parseInt(finalReceiverBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Change:  ${receiverChange > 0 ? '+' : ''}${receiverChange} MIST (${receiverChange / 1000000000} SUI)`);
    console.log("");

    console.log(`🎉 DESTINATION ESCROW TEST COMPLETE!`);
    console.log(`✅ All funds successfully transferred to receiver (maker from source chain)`);
}

// Run the demo
demonstrateDestinationEscrow().catch(console.error);

export { demonstrateDestinationEscrow }; 