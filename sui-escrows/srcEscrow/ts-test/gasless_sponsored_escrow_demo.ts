import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { keccak256, toHex } from 'viem';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Your deployed contract IDs - UPDATED with N+1 secrets system!

const PACKAGE_ID = "0x543a1913d59ef4a4c1119881798540a2af3533e95b580061955b30e43e30fc70"; // Updated package ID

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

async function createSingleEscrow(
    aliceKeypair: Ed25519Keypair,
    bobKeypair: Ed25519Keypair, // Add Bob's keypair for gas sponsorship
    takerAddresses: string[],
    factoryId: string,
    factoryVersion: number,
    escrowNumber: number,
    secretData: any
): Promise<string | null> {
    const aliceAddress = aliceKeypair.toSuiAddress();

    console.log(`\n🔸 CREATING ESCROW ${escrowNumber}`);
    console.log("=".repeat(30));

    // Check Alice's coins
    const aliceCoins = await client.getCoins({
        owner: aliceAddress,
        coinType: '0x2::sui::SUI'
    });

    if (aliceCoins.data.length === 0) {
        throw new Error("Alice has no SUI coins");
    }

    const aliceCoin = aliceCoins.data[0];
    console.log(`Alice coin: ${aliceCoin.coinObjectId} (${aliceCoin.balance} MIST)`);

    // Create gasless transaction
    const gaslessTx = new Transaction();

    // Calculate time windows
    const currentTime = Date.now();
    const dstWithdrawalEnd = currentTime + 600000;      // +10 minutes 
    const dstPublicWithdrawalEnd = currentTime + 900000;  // +15 minutes
    const dstCancellationEnd = currentTime + 1200000;     // +20 minutes

    // Calculate deadline for transaction execution (prevent replay attacks)
    // Alice's signed transaction must be executed within this deadline
    const deadline = currentTime + 600000; // +10 minutes (increased to avoid timing issues)

    // Use the hash of Secret 2 for 50% withdrawal
    const hashLock = uint8ArrayToNumberArray(secretData.leafHashes[1]); // Hash of Secret 2
    const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);

    const numParts = 4;
    const escrowAmount = 1000000; // 0.01 SUI (10M MIST) - reduced to fit Alice's balance

    console.log(`Escrow amount: ${escrowAmount} MIST (${escrowAmount / 1000000000} SUI)`);
    console.log(`Using hash of Secret 2 for 50% withdrawal: ${toHex(secretData.leafHashes[1])}`);
    console.log(`Transaction deadline: ${new Date(deadline).toISOString()} (${deadline - currentTime}ms from now)`);
    console.log(`🔍 Deadline debug: currentTime=${currentTime}, deadline=${deadline}, diff=${deadline - currentTime}`);
    const [splitCoin] = gaslessTx.splitCoins(gaslessTx.object(aliceCoin.coinObjectId), [escrowAmount]);

    // Use the passed taker addresses for N+1 secrets (5 takers for 4 parts)
    console.log(`Secret-to-Taker assignments:`);
    console.log(`  Secret 1 (25%): Bob → ${takerAddresses[0]}`);
    console.log(`  Secret 2 (50%): Bob → ${takerAddresses[1]}`);
    console.log(`  Secret 3 (75%): Car → ${takerAddresses[2]}`);
    console.log(`  Secret 4 (100%): Eve → ${takerAddresses[3]}`);
    console.log(`  Secret 5 (completion): Bob → ${takerAddresses[4]}`);

    // Create escrow with N+1 secrets system
    gaslessTx.moveCall({
        target: `${PACKAGE_ID}::srcescrow::create_and_transfer_escrow`,
        arguments: [
            gaslessTx.sharedObjectRef({              // EXPLICIT mutable shared object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,  // Dynamic version from factory object
                mutable: true
            }),
            splitCoin,                                // Alice's coins  
            gaslessTx.pure.vector('u8', hashLock),    // hash_lock
            gaslessTx.pure.vector('u8', merkleRoot),  // merkle_root
            gaslessTx.pure.vector('address', takerAddresses), // taker_addresses (N+1 = 5)
            gaslessTx.pure.u64(dstWithdrawalEnd),     // dst_withdrawal_end
            gaslessTx.pure.u64(dstPublicWithdrawalEnd), // dst_public_withdrawal_end  
            gaslessTx.pure.u64(dstCancellationEnd),   // dst_cancellation_end
            gaslessTx.pure.u64(numParts),             // num_parts (N=4 → 5 secrets)
            gaslessTx.pure.u64(deadline),             // deadline for transaction execution
            gaslessTx.object('0x6'),                  // clock
        ],
    });

    // Escrow is automatically transferred to first taker

    // Build gasless transaction (NO gas data)
    const kindBytes = await gaslessTx.build({ client, onlyTransactionKind: true });
    console.log(`✅ Alice created GasLessTransactionData`);

    // Bob creates sponsored transaction from gasless data
    const sponsoredTx = Transaction.fromKind(kindBytes);
    sponsoredTx.setSender(aliceAddress);

    // Bob provides gas payment
    const bobCoins = await client.getCoins({
        owner: bobKeypair.toSuiAddress(),
        coinType: '0x2::sui::SUI'
    });

    if (bobCoins.data.length === 0) {
        throw new Error("Bob has no SUI coins for gas sponsorship");
    }

    const bobCoin = bobCoins.data[0];
    sponsoredTx.setGasOwner(bobKeypair.toSuiAddress());
    sponsoredTx.setGasPayment([{
        objectId: bobCoin.coinObjectId,
        version: bobCoin.version,
        digest: bobCoin.digest
    }]);
    sponsoredTx.setGasBudget(20000000); // 0.02 SUI gas budget

    const finalTxBytes = await sponsoredTx.build({ client });

    // Debug the transaction before execution
    console.log(`🔍 Transaction details before execution:`);
    console.log(`   Sender: ${sponsoredTx.blockData.sender}`);
    console.log(`   Gas Owner: ${sponsoredTx.blockData.gasConfig?.owner}`);
    console.log(`   Gas Budget: ${sponsoredTx.blockData.gasConfig?.budget}`);
    console.log(`   Gas Payment: ${JSON.stringify(sponsoredTx.blockData.gasConfig?.payment, null, 2)}`);

    // Both Alice and Bob need to sign
    const aliceSignature = await aliceKeypair.signTransaction(finalTxBytes);
    const bobSignature = await bobKeypair.signTransaction(finalTxBytes);

    console.log(`✅ Alice signed the sponsored transaction`);
    console.log(`✅ Bob signed as gas sponsor`);

    // Execute with both signatures
    let result;
    try {
        result = await client.executeTransactionBlock({
            transactionBlock: finalTxBytes,
            signature: [aliceSignature.signature, bobSignature.signature], // Array of both signatures
            options: {
                showEffects: true,
                showEvents: true,
                showObjectChanges: true,
                showBalanceChanges: true,
            },
        });
    } catch (error) {
        console.log(`❌ Transaction execution failed with error:`);
        console.log(`   Error: ${error}`);
        console.log(`   Error message: ${error.message}`);
        console.log(`   Error details: ${JSON.stringify(error, null, 2)}`);
        return null;
    }

    console.log(`✅ Transaction executed: ${result.digest}`);
    console.log(`✅ Status: ${result.effects?.status?.status}`);

    // Debug transaction result
    console.log(`🔍 Full transaction result:`, JSON.stringify(result, null, 2));

    console.log(`✅ Transaction executed: ${result.digest}`);
    console.log(`✅ Status: ${result.effects?.status?.status}`);

    // Check for creation failure
    if (result.effects?.status?.status !== 'success') {
        console.log(`❌ ESCROW CREATION FAILED!`);
        console.log(`Error details:`, JSON.stringify(result.effects?.status, null, 2));
        return null;
    }

    // Show balance changes from escrow creation
    if (result.balanceChanges && result.balanceChanges.length > 0) {
        console.log(`💰 Escrow creation balance changes:`);
        result.balanceChanges.forEach((change: any) => {
            console.log(`   ${change.owner}: ${change.amount} MIST`);
        });
    }

    // Extract created escrow object
    const createdObjects = result.objectChanges?.filter(
        change => change.type === 'created' &&
            change.objectType?.includes('::srcescrow::Escrow')
    );

    console.log(`🔍 Created objects:`, JSON.stringify(createdObjects, null, 2));
    console.log(`🔍 All object changes:`, JSON.stringify(result.objectChanges, null, 2));

    if (createdObjects && createdObjects.length > 0 && createdObjects[0].type === 'created') {
        const escrowId = createdObjects[0].objectId;
        console.log(`✅ Escrow created: ${escrowId}`);
        return escrowId;
    } else {
        console.log("❌ No escrow object found in transaction result");
        console.log("❌ This means the escrow creation failed!");
        return null;
    }
}


// Multi-step withdrawal functions for different takers
async function performMultiTakerWithdrawals(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    bobKeypair: Ed25519Keypair,
    carKeypair: Ed25519Keypair,   // Car withdraws for herself
    eveKeypair: Ed25519Keypair    // Eve withdraws for herself  
): Promise<void> {
    console.log(`\n🎯 PERFORMING MULTI-TAKER WITHDRAWALS FROM ESCROW: ${escrowId}`);
    console.log("=".repeat(70));

    // Wait for escrow to be indexed
    console.log("⏳ Waiting 3 seconds for escrow indexing...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 1: Bob withdraws his 50% using secret 2
    await bobWithdrawsHalf(escrowId, factoryId, factoryVersion, secretData, bobKeypair);

    // Step 2: Car withdraws her 25% using secret 3 (she has her own gas)
    await carWithdrawsQuarter(escrowId, factoryId, factoryVersion, secretData, carKeypair);

    // Step 3: Eve withdraws her 50% using secret 4 (she has her own gas)
    await eveWithdrawsFinal(escrowId, factoryId, factoryVersion, secretData, eveKeypair);
}

async function bobWithdrawsHalf(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    bobKeypair: Ed25519Keypair
): Promise<void> {
    const bobAddress = bobKeypair.toSuiAddress();

    console.log(`\n🤝 STEP 1: BOB WITHDRAWS 50%`);
    console.log("─".repeat(35));

    // Debug secretData structure
    console.log(`🔍 Debug secretData:`, JSON.stringify(secretData, null, 2));
    console.log(`🔍 secretData.secrets:`, secretData.secrets);
    console.log(`🔍 secretData.secrets[1]:`, secretData.secrets?.[1]);

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
    console.log(`   Withdrawing: ${desiredFillAmount} MIST (50% of escrow - Bob fills parts 0 & 1)`);

    const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
        target: `${PACKAGE_ID}::srcescrow::withdraw_partial`,
        arguments: [
            withdrawTx.object(escrowId),
            withdrawTx.sharedObjectRef({              // EXPLICIT mutable shared object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,  // Dynamic version from factory object
                mutable: true
            }),
            withdrawTx.pure.vector('u8', secret2),
            withdrawTx.pure('vector<vector<u8>>', [merkleRoot]),
            withdrawTx.pure.u64(secretIndex),
            withdrawTx.pure.u64(desiredFillAmount),
            withdrawTx.object('0x6'),
        ],
    });

    withdrawTx.transferObjects([withdrawnCoin], bobAddress);
    withdrawTx.moveCall({
        target: '0x1::option::destroy_none',
        typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
        arguments: [optionalReward]
    });

    withdrawTx.setSender(bobAddress);
    withdrawTx.setGasBudget(15000000);

    const result = await client.signAndExecuteTransaction({
        signer: bobKeypair,
        transaction: withdrawTx,
        options: {
            showEffects: true,
            showObjectChanges: true,
            showBalanceChanges: true
        },
    });

    console.log(`   Transaction: ${result.digest}`);
    console.log(`   Status: ${result.effects?.status?.status}`);

    // Show detailed error if failed
    if (result.effects?.status?.status !== 'success') {
        console.log(`   ❌ WITHDRAWAL FAILED!`);
        console.log(`   Error details:`, JSON.stringify(result.effects?.status, null, 2));
        console.log(`   Full transaction result:`, JSON.stringify(result, null, 2));
        return;
    }

    // Show balance changes
    if (result.balanceChanges && result.balanceChanges.length > 0) {
        console.log(`   💰 Balance changes:`);
        result.balanceChanges.forEach((change: any) => {
            console.log(`      ${change.owner}: ${change.amount} MIST`);
        });
    } else {
        console.log(`   ⚠️  No balance changes detected!`);
    }

    console.log(`   ✅ Bob withdrew 50% successfully!`);
    await new Promise(resolve => setTimeout(resolve, 2000));
}

async function carWithdrawsQuarter(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    carKeypair: Ed25519Keypair  // Car withdraws for herself
): Promise<void> {
    const carAddress = carKeypair.toSuiAddress();

    console.log(`\n🚗 STEP 2: CAR WITHDRAWS HER 25% (25% → 50%)`);
    console.log("─".repeat(45));
    console.log(`   🚗 Car withdraws for herself`);

    try {
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

        // Use secret 3 (index 3) to withdraw up to 75% - funds go to Car
        const secret3 = uint8ArrayToNumberArray(secretData.secrets[2]); // secret 3 (0-indexed)
        const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);

        const secretIndex = 3; // Secret 3 allows up to 75%
        const desiredFillAmount = 3 * partSize; // 3 * part_size = 75% of total

        console.log(`   Escrow total: ${totalAmount} MIST, ${numParts} parts, part size: ${partSize} MIST`);
        console.log(`   Secret 3: ${toHex(secretData.secrets[2])}`);
        console.log(`   Filling to: ${desiredFillAmount} MIST (75% total = +25% more)`);

        const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
            target: `${PACKAGE_ID}::srcescrow::withdraw_partial`,
            arguments: [
                withdrawTx.object(escrowId),
                withdrawTx.sharedObjectRef({              // EXPLICIT mutable shared object
                    objectId: factoryId,
                    initialSharedVersion: factoryVersion,  // Dynamic version from factory object
                    mutable: true
                }),
                withdrawTx.pure.vector('u8', secret3),
                withdrawTx.pure('vector<vector<u8>>', [merkleRoot]),
                withdrawTx.pure.u64(secretIndex),
                withdrawTx.pure.u64(desiredFillAmount),
                withdrawTx.object('0x6'),
            ],
        });

        // Car withdraws for herself
        withdrawTx.transferObjects([withdrawnCoin], carAddress);
        withdrawTx.moveCall({
            target: '0x1::option::destroy_none',
            typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
            arguments: [optionalReward]
        });

        withdrawTx.setSender(carAddress); // Car pays gas
        withdrawTx.setGasBudget(15000000);

        const result = await client.signAndExecuteTransaction({
            signer: carKeypair, // Car signs and pays
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

        if (result.balanceChanges && result.balanceChanges.length > 0) {
            console.log(`   💰 Balance changes:`);
            result.balanceChanges.forEach((change: any) => {
                console.log(`      ${change.owner}: ${change.amount} MIST`);
            });
        } else {
            console.log(`   ⚠️  No balance changes detected!`);
        }

        console.log(`   ✅ Car's 25% withdrawn successfully (via Bob)!`);

    } catch (error) {
        console.log(`   ❌ Car withdrawal failed (expected - no gas): ${error}`);
        console.log(`   💡 This is expected since Car has 0 SUI for gas`);
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
}

async function eveWithdrawsFinal(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    eveKeypair: Ed25519Keypair  // Eve withdraws for herself
): Promise<void> {
    const eveAddress = eveKeypair.toSuiAddress();

    console.log(`\n🎭 STEP 3: EVE WITHDRAWS HER 50% (50% → 100%)`);
    console.log("─".repeat(45));
    console.log(`   🎭 Eve withdraws for herself`);

    try {
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

        // Use secret 4 (index 4) to withdraw up to 100% - funds go to Eve
        const secret4 = uint8ArrayToNumberArray(secretData.secrets[3]); // secret 4 (0-indexed)
        const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);

        const secretIndex = 4; // Secret 4 allows up to 100%
        const desiredFillAmount = 4 * partSize; // 4 * part_size = 100% of total

        console.log(`   Escrow total: ${totalAmount} MIST, ${numParts} parts, part size: ${partSize} MIST`);
        console.log(`   Secret 4: ${toHex(secretData.secrets[3])}`);
        console.log(`   Filling to: ${desiredFillAmount} MIST (100% total = +50% more)`);

        const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
            target: `${PACKAGE_ID}::srcescrow::withdraw_partial`,
            arguments: [
                withdrawTx.object(escrowId),
                withdrawTx.sharedObjectRef({              // EXPLICIT mutable shared object
                    objectId: factoryId,
                    initialSharedVersion: factoryVersion,  // Dynamic version from factory object
                    mutable: true
                }),
                withdrawTx.pure.vector('u8', secret4),
                withdrawTx.pure('vector<vector<u8>>', [merkleRoot]),
                withdrawTx.pure.u64(secretIndex),
                withdrawTx.pure.u64(desiredFillAmount),
                withdrawTx.object('0x6'),
            ],
        });

        // In public window: funds automatically go to assigned taker (Eve)
        withdrawTx.transferObjects([withdrawnCoin], eveAddress);
        withdrawTx.moveCall({
            target: '0x1::option::destroy_none',
            typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
            arguments: [optionalReward]
        });

        withdrawTx.setSender(eveAddress); // Eve pays gas
        withdrawTx.setGasBudget(15000000);

        const result = await client.signAndExecuteTransaction({
            signer: eveKeypair, // Eve signs and pays
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

        if (result.balanceChanges && result.balanceChanges.length > 0) {
            console.log(`   💰 Balance changes:`);
            result.balanceChanges.forEach((change: any) => {
                console.log(`      ${change.owner}: ${change.amount} MIST`);
            });
        } else {
            console.log(`   ⚠️  No balance changes detected!`);
        }

        console.log(`   ✅ Eve's final 25% withdrawn successfully (via Bob)!`);

    } catch (error) {
        console.log(`   ❌ Eve withdrawal failed (expected - no gas): ${error}`);
        console.log(`   💡 This is expected since Eve has 0 SUI for gas`);
    }

    console.log(`\n🎉 ALL WITHDRAWALS COMPLETE! Escrow fully filled by multiple takers!`);
}



async function demonstrateGaslessSponsoredEscrow() {
    console.log("\n🎯 MULTI-TAKER GASLESS ESCROW WITH N+1 MERKLE SECRETS");
    console.log("=======================================================");
    console.log("Features: Multi-taker support + Auction-based allocation + Balance tracking");
    console.log("");

    // === PRIVATE KEYS FROM .ENV ===
    const ALICE_PRIVATE_KEY = (process as any).env.ALICE_PRIVATE_KEY; // Alice/Maker
    const BOB_PRIVATE_KEY = (process as any).env.BOB_PRIVATE_KEY; // Bob/Taker1
    const CAR_PRIVATE_KEY = (process as any).env.CAR_PRIVATE_KEY; // Car/Taker3
    const EVE_PRIVATE_KEY = (process as any).env.EVE_PRIVATE_KEY; // Eve/Taker4

    // Validate environment variables
    if (!ALICE_PRIVATE_KEY || !BOB_PRIVATE_KEY || !CAR_PRIVATE_KEY || !EVE_PRIVATE_KEY) {
        throw new Error('Missing private keys in .env file. Please check ALICE_PRIVATE_KEY, BOB_PRIVATE_KEY, CAR_PRIVATE_KEY, EVE_PRIVATE_KEY');
    }

    if (!PACKAGE_ID) {
        throw new Error('Missing PACKAGE_ID in .env file. Please add PACKAGE_ID to your .env file');
    }

    console.log(`📦 Using PACKAGE_ID from .env: ${PACKAGE_ID}`);

    // Import keypairs
    const aliceKeypair = Ed25519Keypair.fromSecretKey(ALICE_PRIVATE_KEY);
    const bobKeypair = Ed25519Keypair.fromSecretKey(BOB_PRIVATE_KEY);
    const carKeypair = Ed25519Keypair.fromSecretKey(CAR_PRIVATE_KEY);
    const eveKeypair = Ed25519Keypair.fromSecretKey(EVE_PRIVATE_KEY);

    // Get addresses
    const aliceAddress = aliceKeypair.toSuiAddress();
    const bobAddress = bobKeypair.toSuiAddress();
    const carAddress = carKeypair.toSuiAddress();
    const eveAddress = eveKeypair.toSuiAddress();

    console.log(`👩‍💼 Alice (Maker): ${aliceAddress}`);
    console.log(`🤝 Bob (Taker 1): ${bobAddress}`);
    console.log(`🚗 Car (Taker 3): ${carAddress}`);
    console.log(`🎭 Eve (Taker 4): ${eveAddress}`);
    console.log("");
    console.log("🎉 MULTI-TAKER SETUP: Alice, Bob, Car, and Eve!");
    console.log("");

    // Track initial balances for all participants
    const initialAliceBalance = await client.getBalance({ owner: aliceAddress, coinType: '0x2::sui::SUI' });
    const initialBobBalance = await client.getBalance({ owner: bobAddress, coinType: '0x2::sui::SUI' });
    const initialCarBalance = await client.getBalance({ owner: carAddress, coinType: '0x2::sui::SUI' });
    const initialEveBalance = await client.getBalance({ owner: eveAddress, coinType: '0x2::sui::SUI' });

    console.log("💰 INITIAL BALANCES:");
    console.log(`👩‍💼 Alice: ${parseInt(initialAliceBalance.totalBalance)} MIST (${parseInt(initialAliceBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`🤝 Bob: ${parseInt(initialBobBalance.totalBalance)} MIST (${parseInt(initialBobBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`🚗 Car: ${parseInt(initialCarBalance.totalBalance)} MIST (${parseInt(initialCarBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`🎭 Eve: ${parseInt(initialEveBalance.totalBalance)} MIST (${parseInt(initialEveBalance.totalBalance) / 1000000000} SUI)`);
    console.log("");

    // Use the factory
    const factoryId = "0x2948c6d0fef0b0f2c60bec03a84750e31d5a6799711044db6b0346af0ade3b03";
    const factoryVersion = 513761148; // Version from factory creation
    console.log(`🏭 Using factory: ${factoryId}`);
    console.log(`🏭 Factory version: ${factoryVersion}`);
    console.log("");

    // CREATE SINGLE ESCROW USING THE FACTORY
    const numberOfEscrows = 1;
    const createdEscrows: string[] = [];

    console.log(`🏭 CREATING ${numberOfEscrows} ESCROW USING THE FACTORY:`);
    console.log("=".repeat(50));

    // Generate random secrets and merkle root for this escrow
    const secretData = generateRandomSecretsAndMerkleRoot(4); // 4 parts = 5 secrets

    // Create array of taker addresses for the 5 secrets
    const multiTakerAddresses = [
        bobAddress,     // Secret 1: up to 25%
        bobAddress,     // Secret 2: up to 50%  
        carAddress,     // Secret 3: up to 75% - Car
        eveAddress,     // Secret 4: up to 100% - Eve
        bobAddress      // Secret 5: completion secret
    ];

    for (let i = 1; i <= numberOfEscrows; i++) {
        const escrowId = await createSingleEscrow(aliceKeypair, bobKeypair, multiTakerAddresses, factoryId, factoryVersion, i, secretData);
        if (escrowId) {
            createdEscrows.push(escrowId);
        }
    }

    console.log(`\n✅ Created ${createdEscrows.length} escrow successfully!`);
    createdEscrows.forEach((id, index) => {
        console.log(`   Escrow: ${id}`);
    });

    // MULTI-TAKER WITHDRAWALS FROM THE CREATED ESCROW
    console.log(`\n🎯 MULTI-TAKER WITHDRAWALS FROM THE CREATED ESCROW:`);
    console.log("=".repeat(55));

    for (let i = 0; i < createdEscrows.length; i++) {
        await performMultiTakerWithdrawals(
            createdEscrows[i],
            factoryId,
            factoryVersion,
            secretData,
            bobKeypair,
            carKeypair,  // Car withdraws for herself
            eveKeypair   // Eve withdraws for herself
        );
    }

    // FINAL BALANCE TRACKING FOR ALL PARTICIPANTS
    console.log("\n💰 FINAL BALANCE COMPARISON:");
    console.log("===============================");

    const finalAliceBalance = await client.getBalance({ owner: aliceAddress, coinType: '0x2::sui::SUI' });
    const finalBobBalance = await client.getBalance({ owner: bobAddress, coinType: '0x2::sui::SUI' });
    const finalCarBalance = await client.getBalance({ owner: carAddress, coinType: '0x2::sui::SUI' });
    const finalEveBalance = await client.getBalance({ owner: eveAddress, coinType: '0x2::sui::SUI' });

    const aliceChange = parseInt(finalAliceBalance.totalBalance) - parseInt(initialAliceBalance.totalBalance);
    const bobChange = parseInt(finalBobBalance.totalBalance) - parseInt(initialBobBalance.totalBalance);
    const carChange = parseInt(finalCarBalance.totalBalance) - parseInt(initialCarBalance.totalBalance);
    const eveChange = parseInt(finalEveBalance.totalBalance) - parseInt(initialEveBalance.totalBalance);

    console.log(`👩‍💼 Alice (Maker):`);
    console.log(`   Initial: ${parseInt(initialAliceBalance.totalBalance)} MIST (${parseInt(initialAliceBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Final:   ${parseInt(finalAliceBalance.totalBalance)} MIST (${parseInt(finalAliceBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Change:  ${aliceChange > 0 ? '+' : ''}${aliceChange} MIST (${aliceChange / 1000000000} SUI)`);
    console.log("");
    console.log(`🤝 Bob (Taker 50%):`);
    console.log(`   Initial: ${parseInt(initialBobBalance.totalBalance)} MIST (${parseInt(initialBobBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Final:   ${parseInt(finalBobBalance.totalBalance)} MIST (${parseInt(finalBobBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Change:  ${bobChange > 0 ? '+' : ''}${bobChange} MIST (${bobChange / 1000000000} SUI)`);
    console.log("");
    console.log(`🚗 Car (Taker 25%):`);
    console.log(`   Initial: ${parseInt(initialCarBalance.totalBalance)} MIST (${parseInt(initialCarBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Final:   ${parseInt(finalCarBalance.totalBalance)} MIST (${parseInt(finalCarBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Change:  ${carChange > 0 ? '+' : ''}${carChange} MIST (${carChange / 1000000000} SUI)`);
    console.log("");
    console.log(`🎭 Eve (Taker 25%):`);
    console.log(`   Initial: ${parseInt(initialEveBalance.totalBalance)} MIST (${parseInt(initialEveBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Final:   ${parseInt(finalEveBalance.totalBalance)} MIST (${parseInt(finalEveBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`   Change:  ${eveChange > 0 ? '+' : ''}${eveChange} MIST (${eveChange / 1000000000} SUI)`);
    console.log("");

    const totalEscrowValue = numberOfEscrows * 10000000; // 10M MIST each
    const totalWithdrawn = numberOfEscrows * 10000000;   // 10M MIST each (FULLY WITHDRAWN)

    // Check remaining escrow balance
    console.log(`🏦 CHECKING REMAINING ESCROW BALANCE:`);
    console.log("─".repeat(40));
    for (let i = 0; i < createdEscrows.length; i++) {
        try {
            const escrow = await client.getObject({
                id: createdEscrows[i],
                options: { showContent: true }
            });
            console.log(`   Escrow ${i + 1}: ${createdEscrows[i]}`);
            if (escrow.data?.content && 'fields' in escrow.data.content) {
                const balance = (escrow.data.content.fields as any)?.balance;
                if (balance) {
                    console.log(`   Remaining balance: ${balance} MIST`);
                } else {
                    console.log(`   Status: Fully depleted or resolved`);
                }
            }
        } catch (error) {
            console.log(`   Escrow ${i + 1}: Object not found (likely resolved/deleted)`);
        }
    }
    console.log("");
}

// Run the demo
demonstrateGaslessSponsoredEscrow().catch(console.error);

export { demonstrateGaslessSponsoredEscrow }; 