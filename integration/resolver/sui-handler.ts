import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SimpleMerkleTree } from '@openzeppelin/merkle-tree';
import { keccak256, hexToBytes } from 'viem';
import { CrossChainOrder } from './types';

export class SuiHandler {
    private suiClient: SuiClient;
    private bobKeypair: Ed25519Keypair;
    private PACKAGE_ID: string;
    private FACTORY_ID: string;
    private FACTORY_VERSION: string;
    private storedTransactions: Map<string, Uint8Array> = new Map();

    constructor(
        suiClient: SuiClient,
        bobKeypair: Ed25519Keypair,
        packageId: string,
        factoryId: string,
        factoryVersion: string
    ) {
        this.suiClient = suiClient;
        this.bobKeypair = bobKeypair;
        this.PACKAGE_ID = packageId;
        this.FACTORY_ID = factoryId;
        this.FACTORY_VERSION = factoryVersion;
    }

    /**
     * Create transaction and send to maker for signing (STEP 1)
     */
    async createTransactionForSigning(order: CrossChainOrder): Promise<null> {
        // Get Alice's address from the order (resolver doesn't have Alice's private key)
        const aliceAddress = order.makerAddress;

        console.log(`\n🔸 CREATING ESCROW WITH 10 PARTS (FOR SIGNING)`);
        console.log("=".repeat(50));

        // Check Alice's coins
        const aliceCoins = await this.suiClient.getCoins({
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

        // Calculate time windows (EXACTLY like working example)
        const currentTime = Date.now();
        const dstWithdrawalEnd = currentTime + 600000;      // +10 minutes 
        const dstPublicWithdrawalEnd = currentTime + 900000;  // +15 minutes
        const dstCancellationEnd = currentTime + 1200000;     // +20 minutes
        const deadline = currentTime + 600000; // +10 minutes

        const merkleRoot = this.hexToNumberArray(order.merkleRoot);

        const numParts = 10; // 10 parts as requested
        const escrowAmount = 1000000; // 0.001 SUI (1M MIST) - EXACTLY like working example

        console.log(`Escrow amount: ${escrowAmount} MIST (${escrowAmount / 1000000000} SUI)`);
        console.log(`Merkle Root: ${order.merkleRoot}`);
        console.log(`Number of parts: ${numParts}`);

        const [splitCoin] = gaslessTx.splitCoins(gaslessTx.object(aliceCoin.coinObjectId), [escrowAmount]);

        console.log(`   Package ID: ${this.PACKAGE_ID}`);
        console.log(`   Factory ID: ${this.FACTORY_ID}`);
        console.log(`   Factory Version: ${this.FACTORY_VERSION}`);

        gaslessTx.moveCall({
            target: `${this.PACKAGE_ID}::srcescrow::create_and_transfer_escrow`,
            arguments: [
                gaslessTx.sharedObjectRef({
                    objectId: this.FACTORY_ID,
                    initialSharedVersion: parseInt(this.FACTORY_VERSION),
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
        const kindBytes = await gaslessTx.build({ client: this.suiClient, onlyTransactionKind: true });
        console.log(`✅ Resolver created GasLessTransactionData`);

        // Bob creates sponsored transaction
        const sponsoredTx = Transaction.fromKind(kindBytes);
        sponsoredTx.setSender(aliceAddress);

        // Bob provides gas payment
        const bobCoins = await this.suiClient.getCoins({
            owner: this.bobKeypair.toSuiAddress(),
            coinType: '0x2::sui::SUI'
        });

        if (bobCoins.data.length === 0) {
            throw new Error("Bob has no SUI coins for gas sponsorship");
        }

        const bobCoin = bobCoins.data[0];
        sponsoredTx.setGasOwner(this.bobKeypair.toSuiAddress());
        sponsoredTx.setGasPayment([{
            objectId: bobCoin.coinObjectId,
            version: bobCoin.version,
            digest: bobCoin.digest
        }]);
        sponsoredTx.setGasBudget(20000000); // EXACTLY like working example

        const finalTxBytes = await sponsoredTx.build({ client: this.suiClient });

        // Store finalTxBytes for later execution
        this.storedTransactions.set(order.orderId, finalTxBytes);

        // Log final transaction bytes info
        console.log(`🔍 FINAL TX BYTES (for signing):`);
        console.log(`   Length: ${finalTxBytes.length}`);
        console.log(`   First 20: [${Array.from(finalTxBytes.slice(0, 20)).join(', ')}]`);

        console.log(`⏳ Waiting for maker signature...`);
        return null; // Return null to indicate waiting for signature
    }

    /**
     * Execute transaction with both signatures (STEP 2)
     */
    async executeTransactionWithSignature(order: CrossChainOrder): Promise<string | null> {
        console.log(`\n🔸 EXECUTING ESCROW WITH SIGNATURES`);
        console.log("=".repeat(50));

        // Get stored finalTxBytes
        const finalTxBytes = this.storedTransactions.get(order.orderId);
        if (!finalTxBytes) {
            throw new Error(`No stored transaction found for order ${order.orderId}`);
        }

        console.log(`📥 Retrieved stored finalTxBytes (${finalTxBytes.length} bytes)`);

        // Bob signs the transaction
        const bobSignature = await this.bobKeypair.signTransaction(finalTxBytes);
        console.log(`✅ Bob signed as gas sponsor`);
        console.log(`✅ Alice signature received from maker`);

        // Execute with both signatures (EXACTLY like working example)
        let result;
        try {
            result = await this.suiClient.executeTransactionBlock({
                transactionBlock: finalTxBytes,
                signature: [order.makerSignature!, bobSignature.signature], // Alice first, Bob second
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
        console.log(`⏳ Checking for created objects...`);

        const createdObjects = result.objectChanges?.filter(
            change => change.type === 'created'
        );

        console.log(`🔍 DEBUG: Found ${createdObjects?.length || 0} created objects`);
        if (createdObjects && createdObjects.length > 0) {
            createdObjects.forEach((obj, index) => {
                console.log(`   Object ${index}: ${obj.objectType} - ${obj.objectId}`);
            });
        }

        // Look for any created object that might be the escrow
        if (createdObjects && createdObjects.length > 0) {
            // Try to find escrow by object type first
            let escrowObject = createdObjects.find(obj =>
                obj.objectType?.includes('::srcescrow::Escrow') ||
                obj.objectType?.includes('Escrow')
            );

            // If not found, use the first created object (most likely the escrow)
            if (!escrowObject) {
                escrowObject = createdObjects[0];
                console.log(`⚠️  No explicit escrow object found, using first created object`);
            }

            const escrowId = escrowObject.objectId;
            console.log(`✅ Escrow created: ${escrowId}`);
            console.log(`   Object type: ${escrowObject.objectType}`);

            // Clean up stored transaction
            this.storedTransactions.delete(order.orderId);

            return escrowId;
        } else {
            console.log("❌ No created objects found in transaction result");
            console.log("🔍 DEBUG: Full object changes:");
            console.log(JSON.stringify(result.objectChanges, null, 2));
            return null;
        }
    }

    /**
     * Unlock Sui escrow using range withdrawal
     */
    async unlockSuiEscrow(order: CrossChainOrder, secretsData: any, partsToFill: number): Promise<void> {
        console.log(`\n🔓 Step 1: Unlocking Sui escrow with range withdrawal`);
        console.log(`   Sui Escrow: ${order.suiEscrowId}`);
        console.log(`   Using secrets 0-${partsToFill - 1} (range 1-${partsToFill})`);

        // Check if we have a valid Sui escrow ID
        if (!order.suiEscrowId) {
            console.log(`   ⚠️  No Sui escrow ID found for order ${order.orderId}`);
            console.log(`   ⏭️  Skipping Sui escrow unlock`);
            return;
        }

        try {
            // SECURE APPROACH: Use revealed secrets + hashed leaves to rebuild merkle tree
            // Validate we have enough secrets for the parts we want to fill
            if (!secretsData.revealedSecrets || secretsData.revealedSecrets.length < partsToFill) {
                throw new Error(`Need ${partsToFill} revealed secrets for ${partsToFill} parts, but got ${secretsData.revealedSecrets?.length || 0}`);
            }
            // Validate we have hashed leaves for the remaining parts
            const expectedHashedLeaves = order.totalParts - partsToFill;
            if (!secretsData.hashedLeaves || secretsData.hashedLeaves.length !== expectedHashedLeaves) {
                throw new Error(`Expected ${expectedHashedLeaves} hashed leaves for remaining parts, got ${secretsData.hashedLeaves?.length || 0}`);
            }

            // Convert revealed secrets from number arrays back to Uint8Array
            const revealedSecrets = secretsData.revealedSecrets.map((secretArray: number[]) => new Uint8Array(secretArray));
            console.log(`   🔓 Converted ${revealedSecrets.length} revealed secrets to Uint8Array`);

            const secretsForWithdrawal = revealedSecrets;
            console.log(`   🔓 Using revealed secrets 0-${partsToFill - 1} for withdrawal: ${secretsForWithdrawal.length} secrets`);

            // Get authorization data
            const suiAuth = secretsData.authorizationData.suiAuthorization;
            console.log(`   Relayer signature: ${suiAuth.signature}`);
            console.log(`   Range: ${suiAuth.startIndex}-${suiAuth.endIndex}`);

            // Create transaction for range withdrawal
            const tx = new Transaction();

            // Convert relayer public key from object to Uint8Array
            const relayerPublicKeyArray = new Uint8Array(Object.values(suiAuth.publicKey));
            console.log(`   🔍 DEBUG: Public key conversion:`);
            console.log(`     Original: ${JSON.stringify(suiAuth.publicKey)}`);
            console.log(`     Converted: [${Array.from(relayerPublicKeyArray).join(', ')}]`);
            console.log(`     Length: ${relayerPublicKeyArray.length}`);

            // Get escrow data to get version and amount info
            console.log(`   🔍 Getting escrow data for version and amount...`);
            const escrowData = await this.suiClient.getObject({
                id: order.suiEscrowId!,
                options: { showContent: true }
            });

            if (!escrowData.data?.content || !('fields' in escrowData.data.content)) {
                throw new Error("Could not get escrow data");
            }

            const escrowVersion = parseInt(escrowData.data.version);
            const fields = escrowData.data.content.fields as any;
            const totalAmount = parseInt(fields.total_amount);
            const numParts = parseInt(fields.num_parts);
            const partSize = totalAmount / numParts;
            const desiredAmount = partsToFill * partSize;

            console.log(`   Escrow version: ${escrowVersion}`);
            console.log(`   Total amount: ${totalAmount} MIST, ${numParts} parts`);
            console.log(`   Withdrawing: ${partsToFill} parts = ${desiredAmount} MIST`);

            // Convert signature from base64 to bytes
            const signatureBytes = Array.from(Buffer.from(suiAuth.signature, 'base64'));
            const nonceBytes = Array.from(hexToBytes(suiAuth.nonce as `0x${string}`));

            console.log(`   Signature bytes length: ${signatureBytes.length}`);
            console.log(`   Public key bytes length: ${relayerPublicKeyArray.length}`);
            console.log(`   Nonce bytes length: ${nonceBytes.length}`);

            // Generate actual merkle proofs using revealed secrets + hashed leaves
            console.log(`   🌳 Rebuilding merkle tree with revealed secrets + hashed leaves...`);

            // Hash the revealed secrets to create leaves
            const hashedRevealedSecrets = revealedSecrets.map((secret: Uint8Array) => keccak256(secret));

            // Combine hashed revealed secrets + provided hashed leaves
            const allLeafHashes = [...hashedRevealedSecrets, ...secretsData.hashedLeaves];
            console.log(`   🔓 Hashed revealed secrets (0-${partsToFill - 1}): ${hashedRevealedSecrets.length}`);
            console.log(`   🌳 Provided hashed leaves (${partsToFill}-${order.totalParts - 1}): ${secretsData.hashedLeaves.length}`);
            console.log(`   🌳 Total leaf hashes: ${allLeafHashes.length}`);

            // Build tree with SimpleMerkleTree - CRITICAL: sortLeaves: false to preserve order
            const ozTree = SimpleMerkleTree.of(allLeafHashes, { sortLeaves: false });

            console.log(`   Tree root: ${ozTree.root}`);
            console.log(`   Expected root from order: ${order.merkleRoot}`);

            // Verify the tree root matches the one from the order
            if (ozTree.root !== order.merkleRoot) {
                console.error(`   ❌ MERKLE ROOT MISMATCH!`);
                console.error(`     Generated: ${ozTree.root}`);
                console.error(`     Expected:  ${order.merkleRoot}`);
                throw new Error('Merkle root mismatch - tree rebuild failed');
            } else {
                console.log(`   ✅ Merkle root matches! Tree rebuilt correctly.`);
            }

            // Generate proofs for start (secret 0) and end (secret partsToFill-1)
            const endSecretIndex = partsToFill - 1;
            const startProofHex = ozTree.getProof(0);
            const endProofHex = ozTree.getProof(endSecretIndex);

            // Convert hex proofs to number arrays
            const startProof = startProofHex.map((hexString: string) => Array.from(hexToBytes(hexString as `0x${string}`)));
            const endProof = endProofHex.map((hexString: string) => Array.from(hexToBytes(hexString as `0x${string}`)));

            console.log(`   Start proof (secret 0): ${startProof.length} elements`);
            console.log(`   End proof (secret ${endSecretIndex}): ${endProof.length} elements`);

            // Verify proofs work
            const startLeafHash = keccak256(secretsForWithdrawal[0]);
            const endLeafHash = keccak256(secretsForWithdrawal[endSecretIndex]);

            const startVerification = SimpleMerkleTree.verify(ozTree.root as `0x${string}`, startLeafHash as `0x${string}`, startProofHex as `0x${string}`[]);
            const endVerification = SimpleMerkleTree.verify(ozTree.root as `0x${string}`, endLeafHash as `0x${string}`, endProofHex as `0x${string}`[]);

            console.log(`   Start proof verification: ${startVerification}`);
            console.log(`   End proof verification: ${endVerification}`);

            if (!startVerification || !endVerification) {
                throw new Error('Merkle proof verification failed');
            }

            // Call withdraw_partial_range_authorized
            const [withdrawnCoin, optionalReward] = tx.moveCall({
                target: `${this.PACKAGE_ID}::srcescrow::withdraw_partial_range_authorized`,
                arguments: [
                    tx.sharedObjectRef({
                        objectId: order.suiEscrowId!,
                        initialSharedVersion: escrowVersion,
                        mutable: true
                    }),
                    tx.sharedObjectRef({
                        objectId: this.FACTORY_ID,
                        initialSharedVersion: parseInt(this.FACTORY_VERSION),
                        mutable: true
                    }),
                    tx.pure.vector('u8', Array.from(secretsForWithdrawal[0])), // start_secret (secret 0)
                    tx.pure.vector('u8', Array.from(secretsForWithdrawal[endSecretIndex])), // end_secret (dynamic)
                    tx.pure('vector<vector<u8>>', startProof), // start_proof
                    tx.pure('vector<vector<u8>>', endProof), // end_proof
                    tx.pure.u64(suiAuth.startIndex), // start_index (1)
                    tx.pure.u64(suiAuth.endIndex),   // end_index (5)
                    tx.pure.u64(desiredAmount), // desired_fill_amount (exact amount)
                    tx.pure.vector('u8', signatureBytes), // relayer_signature (bytes)
                    tx.pure.vector('u8', Array.from(relayerPublicKeyArray)), // relayer_public_key (bytes)
                    tx.pure.address(this.bobKeypair.toSuiAddress()), // authorized_resolver
                    tx.pure.vector('u8', nonceBytes), // nonce (bytes)
                    tx.object('0x6'), // Clock object
                ]
            });

            // Transfer withdrawn coin to Bob
            tx.transferObjects([withdrawnCoin], this.bobKeypair.toSuiAddress());

            // Destroy optional reward
            tx.moveCall({
                target: '0x1::option::destroy_none',
                typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'],
                arguments: [optionalReward]
            });

            // Set transaction details
            tx.setSender(this.bobKeypair.toSuiAddress());
            tx.setGasOwner(this.bobKeypair.toSuiAddress());
            tx.setGasBudget(20000000);

            // Get gas payment coins
            const gasCoins = await this.suiClient.getCoins({
                owner: this.bobKeypair.toSuiAddress(),
                coinType: '0x2::sui::SUI'
            });

            if (gasCoins.data.length === 0) {
                throw new Error('No SUI coins available for gas payment');
            }

            // Use the first coin for gas
            const gasCoin = gasCoins.data[0];
            console.log(`   Using gas coin: ${gasCoin.coinObjectId} (${gasCoin.balance} MIST)`);

            // Set gas payment with proper format
            tx.setGasPayment([{
                objectId: gasCoin.coinObjectId,
                version: gasCoin.version,
                digest: gasCoin.digest
            }]);

            // Build and sign transaction
            const txBytes = await tx.build({ client: this.suiClient });
            const signature = await this.bobKeypair.signTransaction(txBytes);

            // Execute transaction
            console.log(`   🔄 Executing Sui range withdrawal transaction...`);
            const result = await this.suiClient.executeTransactionBlock({
                transactionBlock: txBytes,
                signature: signature.signature,
                options: {
                    showEffects: true,
                    showEvents: true,
                    showObjectChanges: true
                }
            });

            if (result.effects?.status?.status === 'success') {
                console.log(`   ✅ Sui escrow unlocked successfully!`);
                console.log(`   Transaction: ${result.digest}`);

                // Log any events
                if (result.events && result.events.length > 0) {
                    console.log(`   Events: ${result.events.length} events emitted`);
                }
            } else {
                console.log(`   ❌ Sui unlock failed:`, result.effects?.status);
            }

        } catch (error) {
            console.error(`   ❌ Failed to unlock Sui escrow:`, error);
            throw error;
        }
    }

    /**
     * Get stored transaction bytes for an order
     */
    getStoredTransaction(orderId: string): Uint8Array | undefined {
        return this.storedTransactions.get(orderId);
    }

    /**
     * Helper to convert hex string to number array
     */
    private hexToNumberArray(hex: string): number[] {
        const bytes = hexToBytes(hex as `0x${string}`);
        return Array.from(bytes);
    }
}