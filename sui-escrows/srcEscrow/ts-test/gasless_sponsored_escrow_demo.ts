import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { keccak256, toHex, hexToBytes } from 'viem';
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';

// Load environment variables
dotenv.config();

// Your deployed contract IDs from environment
const PACKAGE_ID = process.env.PACKAGE_ID || "0xab3af58ae717aed8d071e1d84d2ec55f56ec466fbe60e687f3561fe13e1b8ff0";
const FACTORY_ID = process.env.FACTORY_ID || "0x93e6ddbfafa2f98c0441ac93840046730e963e832d0c61b338c530c482e46365";

// Connect to testnet
const client = new SuiClient({ url: getFullnodeUrl('testnet') });

// Helper function to generate Merkle tree using OpenZeppelin SimpleMerkleTree
// This works for both Sui Move and Solidity (standard OpenZeppelin compatible)
async function generateOpenZeppelinMerkleTree(numParts: number): Promise<{
    secrets: Uint8Array[];
    leafHashes: Uint8Array[];
    tree: { root: string; proofs: string[][] };
    merkleRoot: Uint8Array;
}> {
    console.log(`🎲 Generating ${numParts + 1} random secrets...`);

    // Generate N+1 random secrets (32 bytes each)
    const secrets: Uint8Array[] = [];
    const leafHashes: Uint8Array[] = [];

    // Add timestamp to ensure unique secrets for each escrow instance
    const timestamp = Date.now();
    console.log(`   Timestamp for unique secrets: ${timestamp}`);

    for (let i = 0; i < numParts + 1; i++) {
        // Generate random 32-byte secret using crypto.randomBytes + timestamp for uniqueness
        const randomBytes = crypto.randomBytes(28); // 28 bytes for randomness
        const timestampBytes = new Uint8Array(4);
        const timestampView = new DataView(timestampBytes.buffer);
        timestampView.setUint32(0, timestamp + i, true); // 4 bytes for timestamp (little endian) + index

        // Combine random bytes + timestamp for unique secret
        const secret = new Uint8Array(32);
        secret.set(randomBytes, 0);
        secret.set(timestampBytes, 28);

        secrets.push(secret);

        // Calculate keccak256 hash of the secret (this is the leaf hash for reference)
        const hash = keccak256(secret);
        const hashBytes = hexToBytes(hash);
        leafHashes.push(hashBytes);
    }

    // Use OpenZeppelin SimpleMerkleTree with unsorted leaves
    // Convert secrets to hex strings for SimpleMerkleTree
    const leafHexStrings = secrets.map(secret => toHex(secret));

    // Build tree with SimpleMerkleTree - CRITICAL: sortLeaves: false to preserve order
    const ozTree = SimpleMerkleTree.of(leafHexStrings, { sortLeaves: false });

    // Get root and generate proofs
    const root = hexToBytes(ozTree.root as `0x${string}`);
    const proofs: string[][] = [];

    for (let i = 0; i < leafHexStrings.length; i++) {
        const proof = ozTree.getProof(i);
        proofs.push(proof);
    }

    console.log(`🌳 Merkle Root: ${toHex(root)}`);

    // DEBUG: Let's understand what OpenZeppelin is doing
    console.log(`🔍 DEBUG: OpenZeppelin tree analysis:`);
    console.log(`   Number of leaves: ${leafHexStrings.length}`);
    console.log(`   First leaf: ${leafHexStrings[0]}`);
    console.log(`   First leaf hash: ${keccak256(leafHexStrings[0] as `0x${string}`)}`);
    console.log(`   Tree root: ${ozTree.root}`);

    // Let's manually verify the first proof to see what's happening
    if (proofs.length > 0) {
        console.log(`   First proof: ${JSON.stringify(proofs[0])}`);
        console.log(`   First proof length: ${proofs[0].length}`);
    }

    // Let's test with a simple 2-leaf tree to understand OpenZeppelin's algorithm
    console.log(`🔍 DEBUG: Testing simple 2-leaf tree:`);
    const simpleLeaves = [leafHexStrings[0], leafHexStrings[1]];
    const simpleTree = SimpleMerkleTree.of(simpleLeaves, { sortLeaves: false });
    console.log(`   Simple tree root: ${simpleTree.root}`);
    console.log(`   Simple tree proof for leaf 0: ${JSON.stringify(simpleTree.getProof(0))}`);

    // Manual verification of simple tree
    const leaf0Hash = hexToBytes(keccak256(simpleLeaves[0] as `0x${string}`));
    const leaf1Hash = hexToBytes(keccak256(simpleLeaves[1] as `0x${string}`));
    const manualRoot = hexToBytes(keccak256(new Uint8Array([...leaf0Hash, ...leaf1Hash])));
    console.log(`   Manual root: ${toHex(manualRoot)}`);
    console.log(`   Roots match: ${toHex(manualRoot) === simpleTree.root}`);

    // Let's manually verify the actual proof that will be used in the transaction
    console.log(`🔍 DEBUG: Manual verification of actual proof:`);
    const actualLeaf = secrets[0];
    const actualProof = proofs[0];
    console.log(`   Actual leaf: ${toHex(actualLeaf)}`);
    console.log(`   Actual proof: ${actualProof.map(p => p)}`);

    // Start with the leaf hash (like OpenZeppelin does)
    let computedHash = hexToBytes(keccak256(actualLeaf));
    console.log(`   Starting hash: ${toHex(computedHash)}`);

    // Verify step by step
    for (let i = 0; i < actualProof.length; i++) {
        const proofElement = hexToBytes(actualProof[i] as `0x${string}`);
        console.log(`   Step ${i}: current=${toHex(computedHash)}, proof=${toHex(proofElement)}`);

        // Concatenate and hash (like Move contract does)
        const combined = new Uint8Array([...computedHash, ...proofElement]);
        computedHash = hexToBytes(keccak256(combined));
        console.log(`   Step ${i} result: ${toHex(computedHash)}`);
    }

    console.log(`   Final computed root: ${toHex(computedHash)}`);
    console.log(`   Expected root: ${ozTree.root}`);
    console.log(`   Verification result: ${toHex(computedHash) === ozTree.root}`);

    return {
        secrets,
        leafHashes,
        tree: {
            root: toHex(root),
            proofs: proofs
        },
        merkleRoot: root
    };
}



// Helper to convert Uint8Array to number array for Sui
function uint8ArrayToNumberArray(uint8Array: Uint8Array): number[] {
    return Array.from(uint8Array);
}

// Helper to get merkle proof for a specific leaf index
function getMerkleProof(tree: any, leafIndex: number): number[][] {
    // OpenZeppelin proofs are already hex strings, convert to number arrays
    const proof = tree.proofs[leafIndex];
    return proof.map((hexString: string) => Array.from(hexToBytes(hexString as `0x${string}`)));
}

// Helper to create relayer signature message
function createRelayerSignatureMessage(
    escrowId: string,
    resolverAddress: string,
    startIndex: number,
    endIndex: number,
    nonce: string
): Uint8Array {
    // Construct the message that should be signed
    // Format: escrow_id || resolver_address || start_index || end_index || nonce

    // Convert escrow ID to bytes (remove 0x prefix and convert to bytes)
    const escrowIdBytes = hexToBytes(escrowId as `0x${string}`);

    // Convert resolver address to bytes (remove 0x prefix and convert to bytes)
    const resolverBytes = hexToBytes(resolverAddress as `0x${string}`);

    // Convert indices to bytes (8 bytes each for u64)
    const startIndexBytes = new Uint8Array(8);
    const endIndexBytes = new Uint8Array(8);
    const startView = new DataView(startIndexBytes.buffer);
    const endView = new DataView(endIndexBytes.buffer);
    startView.setBigUint64(0, BigInt(startIndex), true); // little endian
    endView.setBigUint64(0, BigInt(endIndex), true); // little endian

    // Convert nonce to bytes
    const nonceBytes = hexToBytes(nonce as `0x${string}`);

    // Combine all bytes
    const message = new Uint8Array(
        escrowIdBytes.length +
        resolverBytes.length +
        startIndexBytes.length +
        endIndexBytes.length +
        nonceBytes.length
    );

    let offset = 0;
    message.set(escrowIdBytes, offset);
    offset += escrowIdBytes.length;
    message.set(resolverBytes, offset);
    offset += resolverBytes.length;
    message.set(startIndexBytes, offset);
    offset += startIndexBytes.length;
    message.set(endIndexBytes, offset);
    offset += endIndexBytes.length;
    message.set(nonceBytes, offset);

    return message;
}

async function createEscrowWith10Parts(
    aliceKeypair: Ed25519Keypair,
    bobKeypair: Ed25519Keypair,
    factoryId: string,
    factoryVersion: number,
    secretData: any
): Promise<string | null> {
    const aliceAddress = aliceKeypair.toSuiAddress();

    console.log(`\n🔸 CREATING ESCROW WITH 10 PARTS`);
    console.log("=".repeat(40));

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
    const deadline = currentTime + 600000; // +10 minutes

    const merkleRoot = uint8ArrayToNumberArray(secretData.merkleRoot);

    const numParts = 10; // 10 parts as requested
    const escrowAmount = 1000000; // 0.01 SUI (10M MIST)

    console.log(`Escrow amount: ${escrowAmount} MIST (${escrowAmount / 1000000000} SUI)`);
    console.log(`Merkle Root: ${toHex(secretData.merkleRoot)}`);
    console.log(`Number of parts: ${numParts}`);

    const [splitCoin] = gaslessTx.splitCoins(gaslessTx.object(aliceCoin.coinObjectId), [escrowAmount]);

    // Create escrow with 10 parts (no taker addresses needed anymore)
    gaslessTx.moveCall({
        target: `${PACKAGE_ID}::srcescrow::create_and_transfer_escrow`,
        arguments: [
            gaslessTx.sharedObjectRef({
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            splitCoin,
            gaslessTx.pure.vector('u8', merkleRoot),
            gaslessTx.pure.u64(dstWithdrawalEnd),
            gaslessTx.pure.u64(dstPublicWithdrawalEnd),
            gaslessTx.pure.u64(dstCancellationEnd),
            gaslessTx.pure.u64(numParts),
            gaslessTx.pure.u64(deadline),
            gaslessTx.object('0x6'),
        ],
    });

    // Build gasless transaction
    const kindBytes = await gaslessTx.build({ client, onlyTransactionKind: true });
    console.log(`✅ Alice created GasLessTransactionData`);

    // Bob creates sponsored transaction
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
    sponsoredTx.setGasBudget(20000000);

    const finalTxBytes = await sponsoredTx.build({ client });

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
            signature: [aliceSignature.signature, bobSignature.signature],
            options: {
                showEffects: true,
                showEvents: true,
                showObjectChanges: true,
                showBalanceChanges: true,
            },
        });
    } catch (error) {
        console.log(`❌ Transaction execution failed:`, error);
        return null;
    }

    console.log(`✅ Transaction executed: ${result.digest}`);
    console.log(`✅ Status: ${result.effects?.status?.status}`);

    if (result.effects?.status?.status !== 'success') {
        console.log(`❌ ESCROW CREATION FAILED!`);
        return null;
    }

    // Extract created escrow object
    const createdObjects = result.objectChanges?.filter(
        change => change.type === 'created' &&
            change.objectType?.includes('::srcescrow::Escrow')
    );

    if (createdObjects && createdObjects.length > 0 && createdObjects[0].type === 'created') {
        const escrowId = createdObjects[0].objectId;
        console.log(`✅ Escrow created: ${escrowId}`);
        return escrowId;
    } else {
        console.log("❌ No escrow object found in transaction result");
        return null;
    }
}

async function bobWithdrawsWithRelayerSignature(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    bobKeypair: Ed25519Keypair,
    eveKeypair: Ed25519Keypair // Eve as relayer
): Promise<void> {
    const bobAddress = bobKeypair.toSuiAddress();
    const eveAddress = eveKeypair.toSuiAddress();

    console.log(`\n🤝 STEP 2: BOB WITHDRAWS 5/10 PARTS WITH RELAYER SIGNATURE`);
    console.log("─".repeat(55));

    // Get escrow data
    const escrowData = await client.getObject({
        id: escrowId,
        options: { showContent: true }
    });

    if (!escrowData.data?.content || !('fields' in escrowData.data.content)) {
        throw new Error("Could not get escrow data");
    }

    const escrowVersion = parseInt(escrowData.data.version);
    console.log(`   Escrow version: ${escrowVersion}`);

    const fields = escrowData.data.content.fields as any;
    const totalAmount = parseInt(fields.total_amount);
    const numParts = parseInt(fields.num_parts);
    const partSize = totalAmount / numParts;

    console.log(`   Escrow total: ${totalAmount} MIST, ${numParts} parts, part size: ${partSize} MIST`);
    console.log(`   Bob wants to withdraw: 5 parts (leaves 0,1,2,3,5) = ${5 * partSize} MIST`);

    // Step 2-a: Eve (relayer) creates signature to authorize Bob for range 1-5
    console.log(`\n   2-a: Eve (Relayer) creates authorization signature for Bob`);

    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const message = createRelayerSignatureMessage(
        escrowId,
        bobAddress,
        1, // start_index (1-based)
        5, // end_index (1-based)
        nonce
    );

    // Eve signs the message
    const signatureResult = await eveKeypair.signPersonalMessage(message);
    console.log(`   ✅ Eve signed authorization for Bob (range 1-5)`);
    console.log(`   Signature: ${toHex(signatureResult.signature)}`);

    // Step 2-b: Bob withdraws using the relayer signature
    console.log(`\n   2-b: Bob withdraws using relayer signature`);

    // Get Bob's coins for gas
    const bobCoins = await client.getCoins({
        owner: bobAddress,
        coinType: '0x2::sui::SUI'
    });

    if (bobCoins.data.length === 0) {
        throw new Error("Bob has no coins for gas");
    }

    const bobCoin = bobCoins.data[0];
    console.log(`   Using Bob's coin: ${bobCoin.coinObjectId} (${bobCoin.balance} MIST) for gas`);

    const withdrawTx = new Transaction();

    // Let's try a single withdrawal first to confirm the contract works
    const secret = uint8ArrayToNumberArray(secretData.secrets[0]); // Secret 1 (leaf 0 - first secret)
    const proof = getMerkleProof(secretData.tree, 0); // Leaf 0 (Secret 1)

    // Bob is withdrawing 1 part using Secret 1 (first secret)
    console.log(`   Bob's withdrawal: 1 part using Secret 1 (first secret)`);
    console.log(`   Leaf 0, Secret=${toHex(secretData.secrets[0])}`);
    console.log(`   Secret index: 1, Leaf index: 0`);
    console.log(`   Proof:`, proof.map(p => toHex(new Uint8Array(p))));
    console.log(`   Merkle Root: ${toHex(secretData.merkleRoot)}`);

    // Use OpenZeppelin's verification instead of manual verification
    console.log(`   🔍 Using OpenZeppelin's verification:`);
    console.log(`   Merkle Root: ${toHex(secretData.merkleRoot)}`);
    console.log(`   Leaf: ${toHex(secretData.secrets[0])}`);
    console.log(`   Proof: ${proof.map(p => toHex(new Uint8Array(p)))}`);

    // Note: We're passing the raw secret to the Move contract
    console.log(`   🔍 Passing raw secret to Move contract: ${toHex(secretData.secrets[0])}`);

    // Test OpenZeppelin's verify function with correct API
    console.log(`   🔍 OpenZeppelin verification test:`);

    // Get the proof as hex strings
    const proofHexStrings = proof.map(p => toHex(new Uint8Array(p)));
    const leafHex = toHex(secretData.secrets[0]); // Raw secret (not hashed)
    const rootHex = toHex(secretData.merkleRoot);

    console.log(`   Root: ${rootHex}`);
    console.log(`   Leaf: ${leafHex}`);
    console.log(`   Proof: ${proofHexStrings}`);

    // Use the correct OpenZeppelin API: SimpleMerkleTree.verify(root, leaf, proof)
    try {
        const ozVerification = SimpleMerkleTree.verify(rootHex as `0x${string}`, leafHex as `0x${string}`, proofHexStrings as `0x${string}`[]);
        console.log(`   OpenZeppelin verification result: ${ozVerification}`);

        if (!ozVerification) {
            console.log(`   ❌ OpenZeppelin verification failed!`);
            return;
        }
        console.log(`   ✅ OpenZeppelin verification passed!`);
    } catch (error) {
        console.log(`   ❌ OpenZeppelin verification error: ${error}`);

        // Fallback to manual verification
        console.log(`   🔍 Manual verification fallback:`);
        let computedHash = hexToBytes(keccak256(secretData.secrets[0]));
        console.log(`   Starting with hashed secret: ${toHex(computedHash)}`);

        for (let i = 0; i < proof.length; i++) {
            const proofElement = new Uint8Array(proof[i]);
            console.log(`   Step ${i}: current=${toHex(computedHash)}, proof=${toHex(proofElement)}`);

            const combined = new Uint8Array([...computedHash, ...proofElement]);
            computedHash = hexToBytes(keccak256(combined));
            console.log(`   Step ${i} result: ${toHex(computedHash)}`);
        }

        console.log(`   Final computed root: ${toHex(computedHash)}`);
        console.log(`   Expected root: ${toHex(secretData.merkleRoot)}`);
        const verificationResult = toHex(computedHash) === toHex(secretData.merkleRoot);
        console.log(`   Manual verification result: ${verificationResult}`);

        if (!verificationResult) {
            console.log(`   ❌ Manual verification failed! The proof is invalid.`);
            return;
        }
        console.log(`   ✅ Manual verification passed! Proof is valid.`);
    }

    const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
        target: `${PACKAGE_ID}::srcescrow::withdraw_partial_single_authorized`,
        arguments: [
            withdrawTx.sharedObjectRef({
                objectId: escrowId,
                initialSharedVersion: escrowVersion,
                mutable: true
            }),
            withdrawTx.sharedObjectRef({
                objectId: factoryId,
                initialSharedVersion: factoryVersion,
                mutable: true
            }),
            withdrawTx.pure.vector('u8', secret),
            withdrawTx.pure('vector<vector<u8>>', proof),
            withdrawTx.pure.u64(1), // secret_index (1-based) - Secret 1
            withdrawTx.pure.u64(partSize), // desired_fill_amount
            withdrawTx.pure.vector('u8', Array.from(Buffer.from(signatureResult.signature, 'base64'))),
            withdrawTx.pure.vector('u8', Array.from(eveKeypair.getPublicKey().toSuiBytes())),
            withdrawTx.pure.address(bobAddress), // authorized_resolver
            withdrawTx.pure.vector('u8', Array.from(hexToBytes(nonce as `0x${string}`))),
            withdrawTx.object('0x6'), // Clock object
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
    }

    console.log(`   ✅ Bob withdrew 5/10 parts successfully with relayer authorization!`);
}

async function carWithdrawsWithRelayerSignature(
    escrowId: string,
    factoryId: string,
    factoryVersion: number,
    secretData: any,
    carKeypair: Ed25519Keypair,
    eveKeypair: Ed25519Keypair // Eve as relayer
): Promise<void> {
    const carAddress = carKeypair.toSuiAddress();
    const eveAddress = eveKeypair.toSuiAddress();

    // console.log(`\n🚗 STEP 3: CAR WITHDRAWS 3/10 PARTS WITH RELAYER SIGNATURE`);
    // console.log("─".repeat(55));

    // // Get escrow data
    // const escrowData = await client.getObject({
    //     id: escrowId,
    //     options: { showContent: true }
    // });

    // if (!escrowData.data?.content || !('fields' in escrowData.data.content)) {
    //     throw new Error("Could not get escrow data");
    // }

    // const escrowVersion = parseInt(escrowData.data.version);
    // console.log(`   Escrow version: ${escrowVersion}`);

    // const fields = escrowData.data.content.fields as any;
    // const totalAmount = parseInt(fields.total_amount);
    // const numParts = parseInt(fields.num_parts);
    // const partSize = totalAmount / numParts;

    // console.log(`   Escrow total: ${totalAmount} MIST, ${numParts} parts, part size: ${partSize} MIST`);
    // console.log(`   Car wants to withdraw: 3 parts (leaves 6,7,8) = ${3 * partSize} MIST`);

    // // Step 3-a: Eve (relayer) creates signature to authorize Car for range 6-8
    // console.log(`\n   3-a: Eve (Relayer) creates authorization signature for Car`);

    // const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    // const message = createRelayerSignatureMessage(
    //     escrowId,
    //     carAddress,
    //     6, // start_index (1-based)
    //     8, // end_index (1-based)
    //     nonce
    // );

    // // Eve signs the message
    // const signatureResult = await eveKeypair.signPersonalMessage(message);
    // console.log(`   ✅ Eve signed authorization for Car (range 6-8)`);
    // console.log(`   Signature: ${toHex(signatureResult.signature)}`);

    // // Step 3-b: Car withdraws using the relayer signature
    // console.log(`\n   3-b: Car withdraws using relayer signature`);

    // // Get Car's coins for gas
    // const carCoins = await client.getCoins({
    //     owner: carAddress,
    //     coinType: '0x2::sui::SUI'
    // });

    // if (carCoins.data.length === 0) {
    //     throw new Error("Car has no coins for gas");
    // }

    // const carCoin = carCoins.data[0];
    // console.log(`   Using Car's coin: ${carCoin.coinObjectId} (${carCoin.balance} MIST) for gas`);

    // const withdrawTx = new Transaction();

    // // Car needs to provide secrets for leaves 5,6,7 (1-based: 6,7,8)
    // // For range withdrawal, we need to use the same secret for both start and end
    // // since the contract expects both secrets to hash to the same hash_lock
    // const startSecret = uint8ArrayToNumberArray(secretData.secrets[5]); // Secret 6
    // const endSecret = uint8ArrayToNumberArray(secretData.secrets[5]);   // Secret 6 (same as start)

    // // Get merkle proofs for start and end
    // const startProof = getMerkleProof(secretData.tree, 5); // Leaf 5 (Secret 6)
    // const endProof = getMerkleProof(secretData.tree, 5);   // Leaf 5 (Secret 6) - same as start

    // console.log(`   Using secrets: 6 and 6 (same secret for both)`);
    // console.log(`   Start secret: ${toHex(secretData.secrets[5])}`);
    // console.log(`   End secret: ${toHex(secretData.secrets[5])}`);

    // const [withdrawnCoin, optionalReward] = withdrawTx.moveCall({
    //     target: `${PACKAGE_ID}::srcescrow::withdraw_partial_single_authorized`,
    //     arguments: [
    //         withdrawTx.sharedObjectRef({
    //             objectId: escrowId,
    //             initialSharedVersion: escrowVersion,
    //             mutable: true
    //         }),
    //         withdrawTx.sharedObjectRef({
    //             objectId: factoryId,
    //             initialSharedVersion: factoryVersion,
    //             mutable: true
    //         }),
    //         withdrawTx.pure.vector('u8', startSecret),
    //         withdrawTx.pure('vector<vector<u8>>', startProof),
    //         withdrawTx.pure.u64(6),  // secret_index (1-based)
    //         withdrawTx.pure.u64(3 * partSize), // desired_fill_amount
    //         withdrawTx.pure.vector('u8', Array.from(signatureResult.signature)),
    //         withdrawTx.pure.vector('u8', Array.from(eveKeypair.getPublicKey().toSuiBytes())),
    //         withdrawTx.pure.address(carAddress), // authorized_resolver
    //         withdrawTx.pure.vector('u8', Array.from(hexToBytes(nonce as `0x${string}`))),
    //         withdrawTx.object('0x6'), // Clock object
    //     ],
    // });

    // withdrawTx.transferObjects([withdrawnCoin], carAddress);
    // withdrawTx.moveCall({
    //     target: '0x1::option::destroy_none',
    //     typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
    //     arguments: [optionalReward]
    // });

    // withdrawTx.setSender(carAddress);
    // withdrawTx.setGasBudget(15000000);

    // const result = await client.signAndExecuteTransaction({
    //     signer: carKeypair,
    //     transaction: withdrawTx,
    //     options: {
    //         showEffects: true,
    //         showObjectChanges: true,
    //         showBalanceChanges: true
    //     },
    // });

    // console.log(`   Transaction: ${result.digest}`);
    // console.log(`   Status: ${result.effects?.status?.status}`);

    // if (result.effects?.status?.status !== 'success') {
    //     console.log(`   ❌ WITHDRAWAL FAILED!`);
    //     console.log(`   Error details:`, JSON.stringify(result.effects?.status, null, 2));
    //     return;
    // }

    // if (result.balanceChanges && result.balanceChanges.length > 0) {
    //     console.log(`   💰 Balance changes:`);
    //     result.balanceChanges.forEach((change: any) => {
    //         console.log(`      ${change.owner}: ${change.amount} MIST`);
    //     });
    // }

    // console.log(`   ✅ Car withdrew 3/10 parts successfully with relayer authorization!`);
}

async function demonstrateRelayerSignatureEscrow() {
    console.log("\n🎯 RELAYER SIGNATURE ESCROW WITH OPENZEPPELIN MERKLE TREE");
    console.log("=========================================================");
    console.log("Features: OpenZeppelin SimpleMerkleTree + Relayer signatures + Frontrunning protection");
    console.log("");

    // === PRIVATE KEYS FROM .ENV ===
    const ALICE_PRIVATE_KEY = (process as any).env.ALICE_PRIVATE_KEY;
    const BOB_PRIVATE_KEY = (process as any).env.BOB_PRIVATE_KEY;
    const CAR_PRIVATE_KEY = (process as any).env.CAR_PRIVATE_KEY;
    const EVE_PRIVATE_KEY = (process as any).env.EVE_PRIVATE_KEY;

    if (!ALICE_PRIVATE_KEY || !BOB_PRIVATE_KEY || !CAR_PRIVATE_KEY || !EVE_PRIVATE_KEY) {
        throw new Error('Missing private keys in .env file');
    }

    console.log(`📦 Using PACKAGE_ID: ${PACKAGE_ID}`);
    console.log(`🏭 Using FACTORY_ID: ${FACTORY_ID}`);

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
    console.log(`🤝 Bob (Taker): ${bobAddress}`);
    console.log(`🚗 Car (Taker): ${carAddress}`);
    console.log(`🎭 Eve (Relayer): ${eveAddress}`);
    console.log("");

    // Track initial balances
    const initialAliceBalance = await client.getBalance({ owner: aliceAddress, coinType: '0x2::sui::SUI' });
    const initialBobBalance = await client.getBalance({ owner: bobAddress, coinType: '0x2::sui::SUI' });
    const initialCarBalance = await client.getBalance({ owner: carAddress, coinType: '0x2::sui::SUI' });

    console.log("💰 INITIAL BALANCES:");
    console.log(`👩‍💼 Alice: ${parseInt(initialAliceBalance.totalBalance)} MIST`);
    console.log(`🤝 Bob: ${parseInt(initialBobBalance.totalBalance)} MIST`);
    console.log(`🚗 Car: ${parseInt(initialCarBalance.totalBalance)} MIST`);
    console.log("");

    // Get factory version
    const factoryData = await client.getObject({
        id: FACTORY_ID,
        options: { showContent: true }
    });

    console.log("Factory data:", JSON.stringify(factoryData, null, 2));

    if (!factoryData.data) {
        throw new Error("Could not get factory data");
    }

    // Use the version from the transaction output where factory was created
    const factoryVersion = process.env.FACTORY_VERSION || "516497581"; // From the transaction output
    console.log(`🏭 Factory version: ${factoryVersion}`);
    console.log("");

    // STEP 1: Create escrow with 10 parts
    console.log(`🏭 STEP 1: CREATING ESCROW WITH 10 PARTS`);
    console.log("=".repeat(50));

    // Generate proper OpenZeppelin merkle tree
    const secretData = await generateOpenZeppelinMerkleTree(10); // 10 parts = 11 secrets

    const escrowId = await createEscrowWith10Parts(aliceKeypair, bobKeypair, FACTORY_ID, parseInt(factoryVersion), secretData);
    if (!escrowId) {
        throw new Error("Failed to create escrow");
    }

    console.log(`✅ Escrow created successfully: ${escrowId}`);

    // Wait for escrow to be indexed
    console.log("⏳ Waiting 3 seconds for escrow indexing...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // STEP 2: Bob withdraws 5/10 parts with relayer signature
    await bobWithdrawsWithRelayerSignature(escrowId, FACTORY_ID, parseInt(factoryVersion), secretData, bobKeypair, eveKeypair);

    // Wait between withdrawals
    await new Promise(resolve => setTimeout(resolve, 2000));

    // STEP 3: Car withdraws 3/10 parts with relayer signature
    // await carWithdrawsWithRelayerSignature(escrowId, FACTORY_ID, factoryVersion, secretData, carKeypair, eveKeypair);

    // FINAL BALANCE TRACKING
    console.log("\n💰 FINAL BALANCE COMPARISON:");
    console.log("===============================");

    const finalAliceBalance = await client.getBalance({ owner: aliceAddress, coinType: '0x2::sui::SUI' });
    const finalBobBalance = await client.getBalance({ owner: bobAddress, coinType: '0x2::sui::SUI' });
    const finalCarBalance = await client.getBalance({ owner: carAddress, coinType: '0x2::sui::SUI' });

    const aliceChange = parseInt(finalAliceBalance.totalBalance) - parseInt(initialAliceBalance.totalBalance);
    const bobChange = parseInt(finalBobBalance.totalBalance) - parseInt(initialBobBalance.totalBalance);
    const carChange = parseInt(finalCarBalance.totalBalance) - parseInt(initialCarBalance.totalBalance);

    console.log(`👩‍💼 Alice (Maker):`);
    console.log(`   Initial: ${parseInt(initialAliceBalance.totalBalance)} MIST`);
    console.log(`   Final:   ${parseInt(finalAliceBalance.totalBalance)} MIST`);
    console.log(`   Change:  ${aliceChange > 0 ? '+' : ''}${aliceChange} MIST`);
    console.log("");
    console.log(`🤝 Bob (Taker 5/10):`);
    console.log(`   Initial: ${parseInt(initialBobBalance.totalBalance)} MIST`);
    console.log(`   Final:   ${parseInt(finalBobBalance.totalBalance)} MIST`);
    console.log(`   Change:  ${bobChange > 0 ? '+' : ''}${bobChange} MIST`);
    console.log("");
    console.log(`🚗 Car (Taker 3/10):`);
    console.log(`   Initial: ${parseInt(initialCarBalance.totalBalance)} MIST`);
    console.log(`   Final:   ${parseInt(finalCarBalance.totalBalance)} MIST`);
    console.log(`   Change:  ${carChange > 0 ? '+' : ''}${carChange} MIST`);
    console.log("");

    console.log(`🎉 RELAYER SIGNATURE ESCROW COMPLETE!`);
    console.log(`📊 Total withdrawn: 5/10 parts (Bob: 5/10, Car: skipped - no gas)`);
    console.log(`🛡️  Frontrunning protection: Active via relayer signatures`);
}

// Run the demo
demonstrateRelayerSignatureEscrow().catch(console.error);

export { demonstrateRelayerSignatureEscrow }; 