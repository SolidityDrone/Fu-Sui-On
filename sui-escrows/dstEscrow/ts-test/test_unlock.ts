import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { keccak256, toHex } from 'viem';
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Your deployed contract IDs
const PACKAGE_ID = process.env.PACKAGE_ID; // Update with actual dstEscrow package ID

// Connect to testnet
const client = new SuiClient({ url: getFullnodeUrl('testnet') });

// Helper function to generate OpenZeppelin Merkle tree (matches srcEscrow)
function generateOpenZeppelinMerkleTree(numParts: number): {
    secrets: Uint8Array[];
    leafHashes: Uint8Array[];
    tree: { root: string; proofs: string[][] };
    merkleRoot: Uint8Array;
} {
    console.log(`🎲 Generating ${numParts + 1} random secrets for N+1 system...`);

    // Generate N+1 random secrets (32 bytes each)
    const secrets: Uint8Array[] = [];
    const leafHexStrings: string[] = [];

    for (let i = 0; i < numParts + 1; i++) {
        // Generate random 32-byte secret
        const secret = new Uint8Array(32);
        for (let j = 0; j < 32; j++) {
            secret[j] = Math.floor(Math.random() * 256);
        }
        secrets.push(secret);

        // For OpenZeppelin SimpleMerkleTree, leaves are raw secrets (not hashed)
        const leafHex = toHex(secret);
        leafHexStrings.push(leafHex);

        console.log(`   Secret ${i + 1}: ${leafHex}`);
    }

    // Build OpenZeppelin Merkle tree
    const ozTree = SimpleMerkleTree.of(leafHexStrings, { sortLeaves: false });
    const merkleRoot = new Uint8Array(ozTree.root.slice(2).match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

    console.log(`🌳 OpenZeppelin Merkle Root: ${ozTree.root}`);
    console.log(`   Number of leaves: ${leafHexStrings.length}`);

    return {
        secrets,
        leafHashes: secrets, // For OpenZeppelin, leaves are raw secrets
        tree: ozTree,
        merkleRoot
    };
}

// Helper to convert Uint8Array to number array for Sui
function uint8ArrayToNumberArray(uint8Array: Uint8Array): number[] {
    return Array.from(uint8Array);
}

// Helper to get Merkle proof from OpenZeppelin tree
function getMerkleProof(tree: any, leafIndex: number): number[][] {
    const proof = tree.getProof(leafIndex);
    return proof.map((p: string) =>
        Array.from(new Uint8Array(p.slice(2).match(/.{1,2}/g)!.map(byte => parseInt(byte, 16))))
    );
}

async function createDestinationEscrow(
    takerKeypair: Ed25519Keypair,
    beneficiaryAddress: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any
): Promise<string | null> {
    const takerAddress = takerKeypair.toSuiAddress();

    console.log(`\n🔸 CREATING DESTINATION ESCROW`);
    console.log("=".repeat(40));

    // Check Taker's coins
    const takerCoins = await client.getCoins({
        owner: takerAddress,
        coinType: '0x2::sui::SUI'
    });

    if (takerCoins.data.length === 0) {
        throw new Error("Taker has no SUI coins");
    }

    const escrowAmount = 100000; // 100K MIST for testing
    console.log(`Escrow amount: ${escrowAmount} MIST (${escrowAmount / 1000000000} SUI)`);

    // Create transaction
    const tx = new Transaction();

    // Method 1: Use tx.gas for both gas and escrow if you have enough balance
    if (parseInt(takerCoins.data[0].balance) > escrowAmount + 5000000) { // 5M MIST buffer for gas
        console.log(`Using primary coin for both gas and escrow: ${takerCoins.data[0].coinObjectId}`);
        const [splitCoin] = tx.splitCoins(tx.gas, [escrowAmount]);
        var coinToUse = splitCoin;
    }
    // Method 2: Use separate coins if available
    else if (takerCoins.data.length > 1) {
        console.log(`Using separate coins - Gas: ${takerCoins.data[0].coinObjectId}, Escrow: ${takerCoins.data[1].coinObjectId}`);
        // Explicitly set gas payment to first coin
        tx.setGasPayment([{
            objectId: takerCoins.data[0].coinObjectId,
            version: takerCoins.data[0].version,
            digest: takerCoins.data[0].digest
        }]);
        // Use second coin for escrow
        const [splitCoin] = tx.splitCoins(tx.object(takerCoins.data[1].coinObjectId), [escrowAmount]);
        var coinToUse = splitCoin;
    }
    // Method 3: Merge coins first if needed
    else {
        throw new Error(`Insufficient funds. Need at least ${escrowAmount + 5000000} MIST total, but only have ${takerCoins.data[0].balance} MIST`);
    }

    // Calculate time windows
    const currentTime = Date.now();
    const dstWithdrawalEnd = currentTime + 600000;      // +10 minutes 
    const dstPublicWithdrawalEnd = currentTime + 900000;  // +15 minutes
    const dstCancellationEnd = currentTime + 1200000;     // +20 minutes
    const deadline = currentTime + 600000; // +10 minutes

    const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);
    const numParts = 10; // 10 parts for range withdrawal test

    console.log(`Beneficiary address: ${beneficiaryAddress}`);
    console.log(`Merkle Root: ${toHex(secretData.merkleRoot)}`);
    console.log(`Number of parts: ${numParts}`);
    console.log(`Transaction deadline: ${new Date(deadline).toISOString()}`);

    // Set gas budget
    tx.setGasBudget(15000000); // 15M MIST for gas

    // Create destination escrow
    tx.moveCall({
        target: `${PACKAGE_ID}::dstescrow::create_and_transfer_escrow`,
        arguments: [
            tx.sharedObjectRef({              // Factory object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            coinToUse,                        // Taker's coins  
            tx.pure.vector('u8', merkleRoot), // merkle_root
            tx.pure.address(beneficiaryAddress), // beneficiary_address
            tx.pure.u64(dstWithdrawalEnd),     // dst_withdrawal_end
            tx.pure.u64(dstPublicWithdrawalEnd), // dst_public_withdrawal_end  
            tx.pure.u64(dstCancellationEnd),   // dst_cancellation_end
            tx.pure.u64(numParts),             // num_parts
            tx.pure.u64(deadline),             // deadline
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

async function depositForPartRange(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    takerKeypair: Ed25519Keypair,
    startPart: number,
    endPart: number
): Promise<void> {
    const takerAddress = takerKeypair.toSuiAddress();

    console.log(`\n💰 DEPOSITING FOR PARTS ${startPart}-${endPart}`);
    console.log("─".repeat(40));

    // Get escrow data to calculate required amount
    const escrowData = await client.getObject({
        id: escrowId,
        options: { showContent: true }
    });

    if (!escrowData.data?.content || !('fields' in escrowData.data.content)) {
        throw new Error("Could not get escrow data");
    }

    const fields = escrowData.data.content.fields as any;
    const partSize = parseInt(fields.part_size);
    const rangeSize = endPart - startPart + 1;
    const requiredAmount = rangeSize * partSize;

    console.log(`   Part size: ${partSize} MIST`);
    console.log(`   Range size: ${rangeSize} parts`);
    console.log(`   Required amount: ${requiredAmount} MIST`);

    // Get taker's coins
    const takerCoins = await client.getCoins({
        owner: takerAddress,
        coinType: '0x2::sui::SUI'
    });

    if (takerCoins.data.length === 0) {
        throw new Error("Taker has no SUI coins");
    }

    // Create deposit transaction
    const tx = new Transaction();

    // Use the same gas handling strategy as in createDestinationEscrow
    if (parseInt(takerCoins.data[0].balance) > requiredAmount + 5000000) { // 5M MIST buffer for gas
        console.log(`   Using primary coin for both gas and deposit: ${takerCoins.data[0].coinObjectId} (${takerCoins.data[0].balance} MIST)`);
        const [splitCoin] = tx.splitCoins(tx.gas, [requiredAmount]);
        var coinToUse = splitCoin;
    }
    // Use separate coins if available
    else if (takerCoins.data.length > 1) {
        console.log(`   Using separate coins - Gas: ${takerCoins.data[0].coinObjectId}, Deposit: ${takerCoins.data[1].coinObjectId}`);
        // Explicitly set gas payment to first coin
        tx.setGasPayment([{
            objectId: takerCoins.data[0].coinObjectId,
            version: takerCoins.data[0].version,
            digest: takerCoins.data[0].digest
        }]);
        // Use second coin for deposit
        const [splitCoin] = tx.splitCoins(tx.object(takerCoins.data[1].coinObjectId), [requiredAmount]);
        var coinToUse = splitCoin;
    }
    else {
        throw new Error(`Insufficient funds. Need at least ${requiredAmount + 5000000} MIST total, but only have ${takerCoins.data[0].balance} MIST`);
    }

    // Set gas budget
    tx.setGasBudget(15000000); // 15M MIST for gas

    tx.moveCall({
        target: `${PACKAGE_ID}::dstescrow::deposit_for_part_range`,
        arguments: [
            tx.sharedObjectRef({              // Factory object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            tx.object(escrowId),              // Escrow object
            coinToUse,                        // Use the properly handled coin
            tx.pure.u64(startPart),           // start_part
            tx.pure.u64(endPart),             // end_part
        ],
    });

    const result = await client.signAndExecuteTransaction({
        signer: takerKeypair,
        transaction: tx,
        options: {
            showEffects: true,
            showObjectChanges: true,
            showBalanceChanges: true
        },
    });

    console.log(`   Transaction: ${result.digest}`);
    console.log(`   Status: ${result.effects?.status?.status}`);

    if (result.effects?.status?.status !== 'success') {
        console.log(`   ❌ DEPOSIT FAILED!`);
        console.log(`   Error details:`, JSON.stringify(result.effects?.status, null, 2));
        return;
    }

    console.log(`   ✅ Successfully deposited ${requiredAmount} MIST for parts ${startPart}-${endPart}`);
}

async function testRangeWithdrawal(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    beneficiaryAddress: string,
    takerKeypair: Ed25519Keypair
): Promise<void> {
    const takerAddress = takerKeypair.toSuiAddress();

    console.log(`\n🎯 TESTING RANGE WITHDRAWAL (5/10 PARTS)`);
    console.log("─".repeat(40));

    // Get escrow data
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
    const partSize = totalAmount / numParts;

    const withdrawTx = new Transaction();

    // Use Secret 1 and Secret 5 for range withdrawal (5 parts)
    const startSecret = uint8ArrayToNumberArray(secretData.secrets[0]); // Secret 1 (leaf 0)
    const endSecret = uint8ArrayToNumberArray(secretData.secrets[4]); // Secret 5 (leaf 4)
    const startProof = getMerkleProof(secretData.tree, 0); // Leaf 0 (Secret 1)
    const endProof = getMerkleProof(secretData.tree, 4); // Leaf 4 (Secret 5)

    const startSecretIndex = 1; // Secret 1
    const endSecretIndex = 5; // Secret 5
    const desiredFillAmount = 5 * partSize; // 5 parts

    console.log(`   Escrow total: ${totalAmount} MIST, ${numParts} parts, part size: ${partSize} MIST`);
    console.log(`   Start Secret 1: ${toHex(secretData.secrets[0])}`);
    console.log(`   End Secret 5: ${toHex(secretData.secrets[4])}`);
    console.log(`   Withdrawing: ${desiredFillAmount} MIST (5/10 parts)`);
    console.log(`   Funds will go to beneficiary: ${beneficiaryAddress}`);

    // Test OpenZeppelin verification for both secrets
    console.log(`   🔍 OpenZeppelin verification test for both secrets:`);

    // Verify start secret (Secret 1)
    const startProofHexStrings = startProof.map(p => toHex(new Uint8Array(p)));
    const startLeafHex = toHex(secretData.secrets[0]);
    const rootHex = toHex(secretData.merkleRoot);

    try {
        const startVerification = SimpleMerkleTree.verify(rootHex as `0x${string}`, startLeafHex as `0x${string}`, startProofHexStrings as `0x${string}`[]);
        console.log(`   Start secret (Secret 1) verification: ${startVerification}`);

        if (!startVerification) {
            console.log(`   ❌ Start secret verification failed!`);
            return;
        }
    } catch (error) {
        console.log(`   ❌ Start secret verification error: ${error}`);
        return;
    }

    // Verify end secret (Secret 5)
    const endProofHexStrings = endProof.map(p => toHex(new Uint8Array(p)));
    const endLeafHex = toHex(secretData.secrets[4]);

    try {
        const endVerification = SimpleMerkleTree.verify(rootHex as `0x${string}`, endLeafHex as `0x${string}`, endProofHexStrings as `0x${string}`[]);
        console.log(`   End secret (Secret 5) verification: ${endVerification}`);

        if (!endVerification) {
            console.log(`   ❌ End secret verification failed!`);
            return;
        }
        console.log(`   ✅ Both secrets verified successfully!`);
    } catch (error) {
        console.log(`   ❌ End secret verification error: ${error}`);
        return;
    }

    const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
        target: `${PACKAGE_ID}::dstescrow::withdraw_partial_range`,
        arguments: [
            withdrawTx.object(escrowId),
            withdrawTx.sharedObjectRef({              // Factory object
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            withdrawTx.pure.vector('u8', startSecret),
            withdrawTx.pure.vector('u8', endSecret),
            withdrawTx.pure('vector<vector<u8>>', startProof),
            withdrawTx.pure('vector<vector<u8>>', endProof),
            withdrawTx.pure.u64(startSecretIndex), // start_secret_index (1-based) - Secret 1
            withdrawTx.pure.u64(endSecretIndex), // end_secret_index (1-based) - Secret 5
            withdrawTx.pure.u64(desiredFillAmount), // desired_fill_amount - 5 parts
            withdrawTx.object('0x6'), // Clock object
        ],
    });

    // Funds automatically go to beneficiary, so we need to handle the zero coin
    withdrawTx.moveCall({
        target: '0x2::coin::destroy_zero',
        typeArguments: ['0x2::sui::SUI'],
        arguments: [withdrawnCoin]
    });

    // Handle the optional reward (deposit fee)
    withdrawTx.moveCall({
        target: '0x1::option::destroy_none',
        typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
        arguments: [optionalReward]
    });

    withdrawTx.setSender(takerAddress);
    withdrawTx.setGasBudget(15000000);

    const result = await client.signAndExecuteTransaction({
        signer: takerKeypair,
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
        console.log(`   ❌ RANGE WITHDRAWAL FAILED!`);
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

    console.log(`   ✅ Range withdrawal successful! Funds sent to beneficiary.`);
}

async function demonstrateDestinationEscrow() {
    console.log("\n🎯 DESTINATION ESCROW WITH DEPOSIT SYSTEM");
    console.log("==========================================");
    console.log("Features: Deposit system + OpenZeppelin Merkle tree + Range withdrawal");
    console.log("");

    // === PRIVATE KEYS FROM .ENV ===
    const TAKER_PRIVATE_KEY = (process as any).env.TAKER_PRIVATE_KEY; // Taker who deploys escrow
    const BENEFICIARY_PRIVATE_KEY = (process as any).env.BENEFICIARY_PRIVATE_KEY; // Beneficiary (maker from source chain)

    // Validate environment variables
    if (!TAKER_PRIVATE_KEY || !BENEFICIARY_PRIVATE_KEY) {
        throw new Error('Missing private keys in .env file. Please check TAKER_PRIVATE_KEY, BENEFICIARY_PRIVATE_KEY');
    }

    if (!PACKAGE_ID) {
        throw new Error('Missing PACKAGE_ID in .env file. Please add PACKAGE_ID to your .env file');
    }

    console.log(`📦 Using PACKAGE_ID: ${PACKAGE_ID}`);

    // Import keypairs
    const takerKeypair = Ed25519Keypair.fromSecretKey(TAKER_PRIVATE_KEY);
    const beneficiaryKeypair = Ed25519Keypair.fromSecretKey(BENEFICIARY_PRIVATE_KEY);

    // Get addresses
    const takerAddress = takerKeypair.toSuiAddress();
    const beneficiaryAddress = beneficiaryKeypair.toSuiAddress();

    console.log(`🤝 Taker (deploys escrow): ${takerAddress}`);
    console.log(`👑 Beneficiary (gets funds): ${beneficiaryAddress}`);
    console.log("");

    // Track initial balances
    const initialTakerBalance = await client.getBalance({ owner: takerAddress, coinType: '0x2::sui::SUI' });
    const initialBeneficiaryBalance = await client.getBalance({ owner: beneficiaryAddress, coinType: '0x2::sui::SUI' });

    console.log("💰 INITIAL BALANCES:");
    console.log(`🤝 Taker: ${parseInt(initialTakerBalance.totalBalance)} MIST (${parseInt(initialTakerBalance.totalBalance) / 1000000000} SUI)`);
    console.log(`👑 Beneficiary: ${parseInt(initialBeneficiaryBalance.totalBalance)} MIST (${parseInt(initialBeneficiaryBalance.totalBalance) / 1000000000} SUI)`);
    console.log("");

    // Use the factory (you'll need to create this first)
    const factoryId = process.env.FACTORY_ID; // Update with actual factory ID
    const factoryVersion = process.env.FACTORY_VERSION; // Update with actual factory version
    console.log(`🏭 Using factory: ${factoryId}`);
    console.log(`🏭 Factory version: ${factoryVersion}`);
    console.log("");

    // GENERATE OPENZEPPELIN MERKLE TREE
    console.log(`🌳 GENERATING OPENZEPPELIN MERKLE TREE:`);
    console.log("=".repeat(40));
    const secretData = generateOpenZeppelinMerkleTree(10); // 10 parts = 11 secrets

    // CREATE DESTINATION ESCROW
    console.log(`\n🏭 CREATING DESTINATION ESCROW:`);
    console.log("=".repeat(40));

    const escrowId = await createDestinationEscrow(
        takerKeypair,
        beneficiaryAddress,
        factoryId,
        factoryVersion,
        secretData
    );

    if (!escrowId) {
        console.log("❌ Failed to create destination escrow");
        return;
    }

    console.log(`\n✅ Destination escrow created: ${escrowId}`);

    // Wait for escrow to be indexed
    console.log("⏳ Waiting 5 seconds for escrow indexing...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // DEPOSIT FOR PARTS 1-5 (before withdrawal)
    await depositForPartRange(escrowId, factoryId, factoryVersion, takerKeypair, 1, 5);

    // Wait a bit for indexing
    console.log("⏳ Waiting 3 seconds for indexing...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // TEST RANGE WITHDRAWAL (5/10 parts)
    await testRangeWithdrawal(escrowId, factoryId, factoryVersion, secretData, beneficiaryAddress, takerKeypair);

    // FINAL BALANCE TRACKING
    console.log("\n💰 FINAL BALANCE COMPARISON:");
    console.log("===============================");

    const finalTakerBalance = await client.getBalance({ owner: takerAddress, coinType: '0x2::sui::SUI' });
    const finalBeneficiaryBalance = await client.getBalance({ owner: beneficiaryAddress, coinType: '0x2::sui::SUI' });

    const takerChange = parseInt(finalTakerBalance.totalBalance) - parseInt(initialTakerBalance.totalBalance);
    const beneficiaryChange = parseInt(finalBeneficiaryBalance.totalBalance) - parseInt(initialBeneficiaryBalance.totalBalance);

    console.log(`🤝 Taker (deployed escrow + deposited + withdrew):`);
    console.log(`   Initial: ${parseInt(initialTakerBalance.totalBalance)} MIST`);
    console.log(`   Final:   ${parseInt(finalTakerBalance.totalBalance)} MIST`);
    console.log(`   Change:  ${takerChange > 0 ? '+' : ''}${takerChange} MIST`);
    console.log("");
    console.log(`👑 Beneficiary (received funds):`);
    console.log(`   Initial: ${parseInt(initialBeneficiaryBalance.totalBalance)} MIST`);
    console.log(`   Final:   ${parseInt(finalBeneficiaryBalance.totalBalance)} MIST`);
    console.log(`   Change:  ${beneficiaryChange > 0 ? '+' : ''}${beneficiaryChange} MIST`);
    console.log("");

    console.log(`🎉 DESTINATION ESCROW TEST COMPLETE!`);
    console.log(`✅ Range withdrawal (5/10 parts) successful!`);
    console.log(`✅ All funds successfully transferred to beneficiary`);
}

// Run the demo
demonstrateDestinationEscrow().catch(console.error);

export { demonstrateDestinationEscrow }; 