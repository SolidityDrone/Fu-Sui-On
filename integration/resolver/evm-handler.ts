import { createWalletClient, createPublicClient, parseAbi, keccak256, toHex } from 'viem';
import { CrossChainOrder } from './types';

export class EvmHandler {
    private evmPublicClient: any;
    private evmWalletClient: any;
    private evmAccount: any;
    private evmFactoryAddress: `0x${string}`;

    constructor(
        evmPublicClient: any,
        evmWalletClient: any,
        evmAccount: any,
        evmFactoryAddress: `0x${string}`
    ) {
        this.evmPublicClient = evmPublicClient;
        this.evmWalletClient = evmWalletClient;
        this.evmAccount = evmAccount;
        this.evmFactoryAddress = evmFactoryAddress;
    }

    /**
     * Pack timelocks EXACTLY like the SDK's build() method (the key discovery!)
     */
    private packTimelocks(
        srcWithdrawal: number,
        srcPublicWithdrawal: number,
        srcCancellation: number,
        srcPublicCancellation: number,
        dstWithdrawal: number,
        dstPublicWithdrawal: number,
        dstCancellation: number,
        deployedAt: number
    ): bigint {
        // SDK's build() method order: [deployedAt, dstCancellation, dstPublicWithdrawal, dstWithdrawal, srcPublicCancellation, srcCancellation, srcPublicWithdrawal, srcWithdrawal]
        return [
            BigInt(deployedAt),           // [0] - deployedAt
            BigInt(dstCancellation),      // [1] - dstCancellation
            BigInt(dstPublicWithdrawal),  // [2] - dstPublicWithdrawal
            BigInt(dstWithdrawal),        // [3] - dstWithdrawal
            BigInt(srcPublicCancellation), // [4] - srcPublicCancellation
            BigInt(srcCancellation),      // [5] - srcCancellation
            BigInt(srcPublicWithdrawal),  // [6] - srcPublicWithdrawal
            BigInt(srcWithdrawal)         // [7] - srcWithdrawal
        ].reduce((acc, el) => (acc << BigInt(32)) | el);
    }

    /**
     * Deploy EVM escrow EXACTLY like the successful test
     */
    async deployEvmEscrow(order: CrossChainOrder): Promise<string> {
        console.log(`\n🔧 Step 2: Deploying EVM destination escrow (copying test exactly)`);

        // EXACT VALUES from the working test
        const dstAmount = BigInt(1000000000000000); // 0.001 ether
        const safetyDeposit = BigInt(1000000000000000); // 0.001 ether

        console.log(`   Amount: ${dstAmount} wei`);
        console.log(`   Safety Deposit: ${safetyDeposit} wei`);

        // Deploy escrow using the factory contract
        console.log(`   Deploying escrow via factory: ${this.evmFactoryAddress}`);

        // Use the EXACT ABI that works (uint256 for addresses - the key discovery!)
        const abi = [
            {
                inputs: [
                    {
                        components: [
                            { name: "orderHash", type: "bytes32" },
                            { name: "hashlock", type: "bytes32" },
                            { name: "maker", type: "uint256" },
                            { name: "taker", type: "uint256" },
                            { name: "token", type: "uint256" },
                            { name: "amount", type: "uint256" },
                            { name: "safetyDeposit", type: "uint256" },
                            { name: "timelocks", type: "uint256" },
                            { name: "parameters", type: "bytes" }
                        ],
                        name: "dstImmutables",
                        type: "tuple"
                    },
                    { name: "srcCancellationTimestamp", type: "uint256" }
                ],
                name: "createDstEscrow",
                outputs: [],
                stateMutability: "payable",
                type: "function"
            }
        ] as const;

        try {
            // Check ETH balance with VIEM
            const balance = await this.evmPublicClient.getBalance({ address: this.evmAccount.address });
            const requiredAmount = dstAmount + safetyDeposit;

            console.log(`   📊 Bob's ETH balance: ${balance} wei`);
            console.log(`   📊 Required ETH: ${requiredAmount} wei`);

            if (balance < requiredAmount) {
                throw new Error(`Insufficient ETH balance. Need ${requiredAmount} wei, have ${balance} wei`);
            }

            // Use EXACT values from the order (consistent between deployment and withdrawal)
            const orderHash = process.env.ORDER_HASH || keccak256(toHex(order.orderId));

            // Use current timestamp for deployment (will be corrected after deployment)
            const deployedAt = Math.floor(Date.now() / 1000);

            // Pack timelocks with current timestamp (will be corrected after deployment)
            const packedTimelocks = this.packTimelocks(
                1,      // srcWithdrawal: immediate
                2000,   // srcPublicWithdrawal
                3000,   // srcCancellation
                4000,   // srcPublicCancellation
                1,      // dstWithdrawal: immediate (for testing)
                2000,   // dstPublicWithdrawal
                3000,   // dstCancellation
                deployedAt
            );

            // Use type(uint32).max for srcCancellationTimestamp
            const srcCancellationTimestamp = 2 ** 32 - 1;

            console.log(`   📝 Using ORDER_HASH: ${orderHash}`);
            console.log(`   📝 Using deployedAt: ${deployedAt}`);
            console.log(`   📝 Using packed TIMELOCKS: ${packedTimelocks}`);

            // Debug: Verify our timelocks packing
            const deployedAtFromPacked = Number((packedTimelocks >> BigInt(224)) & BigInt(0xFFFFFFFF));
            const dstCancellationOffset = Number(packedTimelocks >> BigInt(192) & BigInt(0xFFFFFFFF));
            const calculatedDstCancellation = deployedAtFromPacked + dstCancellationOffset;
            console.log(`   🔍 Debug timelocks:`);
            console.log(`     Packed deployedAt: ${deployedAtFromPacked}`);
            console.log(`     DstCancellation offset: ${dstCancellationOffset}`);
            console.log(`     Calculated dstCancellation: ${calculatedDstCancellation}`);
            console.log(`     srcCancellationTimestamp: ${srcCancellationTimestamp}`);
            console.log(`     Time check: ${calculatedDstCancellation} <= ${srcCancellationTimestamp} = ${calculatedDstCancellation <= srcCancellationTimestamp}`);

            // Get hashlock from maker's leaf hashes based on parts to fill
            const hashlockIndex = (order.partsToFill || 5) - 1; // Dynamic hashlock index based on partsToFill
            if (!order.leafHashes || order.leafHashes.length <= hashlockIndex) {
                throw new Error(`Order missing leaf hashes. Need at least ${hashlockIndex + 1} leaf hashes, got ${order.leafHashes?.length || 0}`);
            }
            const hashlockFixed = order.leafHashes[hashlockIndex] as `0x${string}`; // Dynamic leaf hash based on partsToFill

            // Get maker from order (Alice's EVM address) and taker is Bob
            const makerAddr = (order.makerEvmAddress || "0x3d849a98e5147a416f63f0b7c664b861b234ef5f") as `0x${string}`;
            const takerAddr = this.evmAccount.address as `0x${string}`;
            const tokenAddr = "0x0000000000000000000000000000000000000000" as `0x${string}`; // ETH

            const srcCancellationTimestampFixed = BigInt(4294967295); // type(uint32).max

            console.log(`   📋 Using values from order:`);
            console.log(`     Order Hash: ${orderHash}`);
            console.log(`     Hashlock: ${hashlockFixed} (from maker's 5th leaf hash)`);
            console.log(`     Maker: ${makerAddr} (Alice from order)`);
            console.log(`     Taker: ${takerAddr} (Bob)`);
            console.log(`     Packed Timelocks: ${packedTimelocks}`);
            console.log(`     Available leaf hashes: ${order.leafHashes.length}`);

            // Convert addresses to uint256 (like the successful test)
            const makerUint256 = BigInt(makerAddr);
            const takerUint256 = BigInt(takerAddr);
            const tokenUint256 = BigInt(tokenAddr);

            // Build parameters like buildDstEscrowImmutables does
            const protocolFeeAmount = BigInt(0);
            const integratorFeeAmount = BigInt(0);
            const protocolFeeRecipient = this.evmAccount.address;
            const integratorFeeRecipient = this.evmAccount.address;

            // Encode parameters exactly like buildDstEscrowImmutables
            const parametersEncoded = `0x${[
                protocolFeeAmount.toString(16).padStart(64, '0'),
                integratorFeeAmount.toString(16).padStart(64, '0'),
                BigInt(protocolFeeRecipient).toString(16).padStart(64, '0'),
                BigInt(integratorFeeRecipient).toString(16).padStart(64, '0')
            ].join('')}`;

            const dstImmutables = {
                orderHash: orderHash as `0x${string}`,
                hashlock: hashlockFixed,
                maker: makerUint256,
                taker: takerUint256,
                token: tokenUint256,
                amount: dstAmount,
                safetyDeposit: safetyDeposit,
                timelocks: packedTimelocks,
                parameters: parametersEncoded
            };

            console.log(`   📋 Parameters encoded: ${parametersEncoded}`);

            console.log(`   🚀 Deploying escrow with VIEM...`);

            // Send the transaction with VIEM
            const hash = await this.evmWalletClient.writeContract({
                address: this.evmFactoryAddress,
                abi,
                functionName: 'createDstEscrow',
                args: [dstImmutables, srcCancellationTimestampFixed],
                value: requiredAmount
            });

            console.log(`   📝 Transaction sent: ${hash}`);
            console.log(`   ⏳ Waiting for confirmation...`);

            const receipt = await this.evmPublicClient.waitForTransactionReceipt({ hash });

            console.log(`   ✅ Transaction confirmed in block ${receipt.blockNumber}`);
            console.log(`   ⛽ Gas used: ${receipt.gasUsed}`);

            // Get actual block timestamp and correct the timelocks (the key discovery!)
            let deploymentBlock;
            let retries = 0;
            const maxRetries = 5;
            const retryDelay = 2000; // 2 seconds

            while (retries < maxRetries) {
                try {
                    deploymentBlock = await this.evmPublicClient.getBlock({ blockNumber: receipt.blockNumber });
                    if (deploymentBlock) break;
                } catch (error) {
                    console.log(`   ⏳ Block not indexed yet, retry ${retries + 1}/${maxRetries}...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                    retries++;
                    if (retries === maxRetries) throw error;
                }
            }

            const actualBlockTimestamp = Number(deploymentBlock.timestamp);

            console.log(`   ⏰ Timestamp correction:`);
            console.log(`     Script deployedAt: ${deployedAt}`);
            console.log(`     Actual block timestamp: ${actualBlockTimestamp}`);

            // Reconstruct timelocks with actual block timestamp (like the contract does internally)
            const correctedTimelocks = this.packTimelocks(
                1,      // srcWithdrawal: immediate
                2000,   // srcPublicWithdrawal
                3000,   // srcCancellation
                4000,   // srcPublicCancellation
                1,      // dstWithdrawal: immediate (for testing)
                2000,   // dstPublicWithdrawal
                3000,   // dstCancellation
                actualBlockTimestamp  // Use actual block timestamp
            );

            console.log(`   🔄 Timelocks correction:`);
            console.log(`     Original: ${packedTimelocks}`);
            console.log(`     Corrected: ${correctedTimelocks}`);

            // Wait 2 seconds for the escrow object to be properly indexed
            console.log(`   ⏳ Waiting 2 seconds for escrow object to be indexed...`);
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Parse the escrow address from the transaction logs
            let evmEscrowAddress = null;
            console.log(`   🔍 Parsing Transaction Logs (${receipt.logs.length} logs)`);

            // Look for DstEscrowCreated event
            for (const log of receipt.logs) {
                if (log.topics[0] === '0xc30e111dcc74fddc2c3a4d98ffb97adec4485c0a687946bf5b22c2a99c7ff96d') {
                    // This is the DstEscrowCreated event topic from the successful test
                    evmEscrowAddress = `0x${log.data.slice(26, 66)}`; // Extract address from data
                    console.log(`   📍 Found DstEscrowCreated event!`);
                    console.log(`   📍 Escrow Address: ${evmEscrowAddress}`);
                    break;
                }
            }

            if (!evmEscrowAddress) {
                console.log(`   ⚠️  Could not parse escrow address from logs`);
                console.log(`   🔍 All log topics:`);
                receipt.logs.forEach((log: any, index: number) => {
                    console.log(`     Log ${index}: ${log.topics[0]}`);
                });
                throw new Error('Could not determine escrow address from deployment');
            }

            console.log(`   🎉 EVM destination escrow deployed successfully!`);
            console.log(`   📍 EVM Escrow Address: ${evmEscrowAddress}`);
            console.log(`   💰 Locked: ${dstAmount} wei + ${safetyDeposit} wei safety deposit`);
            console.log(`   🔐 Hashlock: ${hashlockFixed}`);
            console.log(`   ✅ VIEM deployment successful!`);

            // Store the corrected timestamp and timelocks in the order for consistent withdrawal
            order.deployedAt = actualBlockTimestamp;

            // Store corrected immutables for withdrawal
            const correctedImmutables = {
                orderHash: orderHash as `0x${string}`,
                hashlock: hashlockFixed,
                maker: makerUint256,
                taker: takerUint256,
                token: tokenUint256,
                amount: dstAmount,
                safetyDeposit: safetyDeposit,
                timelocks: correctedTimelocks,  // Use corrected timelocks
                parameters: parametersEncoded
            };

            // Store in order for withdrawal
            order.correctedImmutables = correctedImmutables;

            return evmEscrowAddress;

        } catch (error: any) {
            console.error(`   ❌ Failed to deploy EVM escrow:`, error);
            throw error;
        }
    }

    /**
     * Unlock EVM escrow using single secret
     */
    async unlockEvmEscrow(order: CrossChainOrder, secretsData: any): Promise<void> {
        console.log(`\n🔓 Step 2: Unlocking EVM escrow with single secret`);
        console.log(`   EVM Escrow: ${order.evmEscrowAddress || 'Unknown'}`);
        const secretIndex = (order.partsToFill || 5) - 1; // Dynamic secret index based on partsToFill
        console.log(`   Using secret ${secretIndex}`);

        try {
            if (!order.evmEscrowAddress) {
                throw new Error('EVM escrow address not found');
            }

            // Convert secret from number array back to Uint8Array
            const evmSecret = new Uint8Array(secretsData.evmSecret);
            console.log(`   Secret (hex): 0x${Array.from(evmSecret).map(b => b.toString(16).padStart(2, '0')).join('')}`);

            // Verify the secret matches the expected hashlock from deployment
            const secretBytes32 = `0x${Array.from(evmSecret).map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
            const expectedHashlock = keccak256(secretBytes32);
            const deployedHashlock = order.leafHashes?.[secretIndex]; // The hashlock used during deployment (dynamic index)

            console.log(`   🔍 Secret verification:`);
            console.log(`     Secret: ${secretBytes32}`);
            console.log(`     Expected hashlock: ${expectedHashlock}`);
            console.log(`     Deployed hashlock: ${deployedHashlock}`);
            console.log(`     Match: ${expectedHashlock === deployedHashlock}`);

            if (expectedHashlock !== deployedHashlock) {
                console.log(`   ❌ Secret doesn't match deployed hashlock!`);
                throw new Error(`Secret verification failed: ${expectedHashlock} !== ${deployedHashlock}`);
            }

            console.log(`   ✅ Secret verified! Attempting withdrawal...`);

            // Use the corrected immutables from deployment (the key discovery!)
            if (!order.correctedImmutables) {
                throw new Error('No corrected immutables found - deployment may have failed');
            }

            const immutables = order.correctedImmutables;

            console.log(`   ✅ Using corrected immutables from deployment:`);

            console.log(`   📋 Using corrected immutables:`);
            console.log(`     Order Hash: ${immutables.orderHash}`);
            console.log(`     Hashlock: ${immutables.hashlock}`);
            console.log(`     Maker: ${immutables.maker}`);
            console.log(`     Taker: ${immutables.taker}`);
            console.log(`     Amount: ${immutables.amount} wei`);
            console.log(`     Safety Deposit: ${immutables.safetyDeposit} wei`);
            console.log(`     Timelocks: ${immutables.timelocks}`);
            console.log(`     Parameters: ${immutables.parameters}`);

            // Call withdraw function with secret and immutables
            console.log(`   🔄 Calling withdraw with secret and immutables...`);

            // Add detailed error handling to get the specific revert reason
            let hash: `0x${string}`;
            try {
                hash = await this.evmWalletClient.writeContract({
                    address: order.evmEscrowAddress as `0x${string}`,
                    abi: parseAbi([
                        'function withdraw(bytes32 secret, (bytes32 orderHash, bytes32 hashlock, uint256 maker, uint256 taker, uint256 token, uint256 amount, uint256 safetyDeposit, uint256 timelocks, bytes parameters) immutables) external'
                    ]),
                    functionName: 'withdraw',
                    args: [secretBytes32, immutables],
                    account: this.evmAccount
                });

                console.log(`   📤 Transaction sent: ${hash}`);
            } catch (error: any) {
                console.log(`   ❌ Detailed error info:`);
                console.log(`     Error message: ${error.message}`);
                console.log(`     Short message: ${error.shortMessage}`);
                console.log(`     Reason: ${error.reason}`);
                console.log(`     Data: ${error.data}`);

                // Try to decode the revert reason if available
                if (error.data) {
                    console.log(`     Raw data: ${error.data}`);
                }

                throw error;
            }

            // Wait for confirmation
            console.log(`   ⏳ Waiting for transaction confirmation...`);
            const receipt = await this.evmPublicClient.waitForTransactionReceipt({
                hash,
                timeout: 60000 // 60 second timeout
            });

            if (receipt.status === 'success') {
                console.log(`   ✅ EVM escrow unlocked successfully!`);
                console.log(`   Block: ${receipt.blockNumber}`);
                console.log(`   Gas used: ${receipt.gasUsed}`);

                console.log(`   ✅ Withdrawal transaction confirmed successfully!`);
            } else {
                console.log(`   ❌ EVM unlock transaction failed`);
                console.log(`   Receipt:`, receipt);
            }

        } catch (error) {
            console.error(`   ❌ Failed to unlock EVM escrow:`, error);
            throw error;
        }
    }
}