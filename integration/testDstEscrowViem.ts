#!/usr/bin/env ts-node

import { createWalletClient, createPublicClient, http, parseEther, parseUnits, keccak256, encodePacked, encodeAbiParameters, getCreate2Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

/**
 * Test script to deploy EVM destination escrow using VIEM (not ethers)
 * This replicates the EXACT transaction from the successful forge script
 */
async function testDstEscrowDeploymentViem() {
    console.log('🔧 Testing EVM Destination Escrow Deployment with VIEM');
    console.log('='.repeat(60));

    // Initialize wallet and client with VIEM
    const bobEthPrivateKeyRaw = process.env.BOB_ETH_PRIVATE_KEY;
    if (!bobEthPrivateKeyRaw) {
        throw new Error('BOB_ETH_PRIVATE_KEY not found in environment variables');
    }

    // Ensure private key has 0x prefix for VIEM
    const bobEthPrivateKey = bobEthPrivateKeyRaw.startsWith('0x')
        ? bobEthPrivateKeyRaw as `0x${string}`
        : `0x${bobEthPrivateKeyRaw}` as `0x${string}`;

    const account = privateKeyToAccount(bobEthPrivateKey);

    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
    });

    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
    });

    const evmFactoryAddress = (process.env.BASE_ESCROW_FACTORY || '0x6e7F7f50Ce82F1A49e9F9292B1EF1538E5B52d1A') as `0x${string}`;

    console.log(`📋 Configuration:`);
    console.log(`   Provider: ${process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'}`);
    console.log(`   Wallet: ${account.address}`);
    console.log(`   Factory: ${evmFactoryAddress}`);

    // Dynamic values that will match between deployment and withdrawal
    const dstAmount = parseEther("0.00001"); // 0.00001 ether
    const safetyDeposit = parseEther("0.00001"); // 0.00001 ether
    const orderHash = "0x477561726461746543686543617a7a6f4d655374617465414661466100000000" as `0x${string}`; // "GuardateCheCazzoMeStateAFaFa" padded to bytes32
    const secret = keccak256(encodePacked(['string'], ['secret'])) as `0x${string}`; // Dynamic secret generation
    const hashlock = keccak256(encodePacked(['bytes32'], [secret])) as `0x${string}`; // keccak256(abi.encode(secret)) like Forge
    const maker = account.address;
    const taker = account.address;
    const token = "0x0000000000000000000000000000000000000000" as `0x${string}`; // ETH
    const deployedAt = Math.floor(Date.now() / 1000); // Current timestamp
    const srcCancellationTimestamp = 4294967295n; // type(uint32).max

    // Pack timelocks EXACTLY like the SDK's build() method
    const packTimelocks = (
        srcWithdrawal: number, srcPublicWithdrawal: number, srcCancellation: number, srcPublicCancellation: number,
        dstWithdrawal: number, dstPublicWithdrawal: number, dstCancellation: number, deployedAt: number
    ): bigint => {
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
        ].reduce((acc, el) => (acc << 32n) | el)
    }

    // Pack timelocks dynamically with the deployedAt timestamp
    const timelocks = packTimelocks(
        1,      // srcWithdrawal: immediate
        2000,   // srcPublicWithdrawal
        3000,   // srcCancellation
        4000,   // srcPublicCancellation
        1,      // dstWithdrawal: immediate (for testing)
        2000,   // dstPublicWithdrawal
        3000,   // dstCancellation
        deployedAt
    );

    console.log(`\n💰 Amounts:`);
    console.log(`   Amount: ${dstAmount} wei`);
    console.log(`   Safety Deposit: ${safetyDeposit} wei`);

    console.log(`\n🔐 Parameters (from successful forge script):`);
    console.log(`   Order Hash: ${orderHash}`);
    console.log(`   Hashlock: ${hashlock}`);
    console.log(`   Maker: ${maker}`);
    console.log(`   Taker: ${taker}`);
    console.log(`   Token: ${token} (native ETH)`);
    console.log(`   Timelocks: ${timelocks}`);
    console.log(`   Src Cancellation: ${srcCancellationTimestamp}`);

    try {
        // Check ETH balance
        const balance = await publicClient.getBalance({ address: account.address });
        const requiredAmount = dstAmount + safetyDeposit; // 2 wei total

        console.log(`\n📊 Balance Check:`);
        console.log(`   ETH balance: ${balance} wei`);
        console.log(`   Required ETH: ${requiredAmount} wei`);

        if (balance < requiredAmount) {
            throw new Error(`Insufficient ETH balance. Need ${requiredAmount} wei, have ${balance} wei`);
        }

        console.log(`\n🚀 Deploying escrow with VIEM...`);
        console.log(`   Sending ${requiredAmount} wei with transaction`);

        // Use the EXACT ABI from the working DeployEscrowDst.s.sol script (original uint256 for addresses)
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

        // Convert addresses to bigint for uint160 ABI types
        // Convert addresses to bigint for uint256 ABI types (the key fix!)
        const makerBigInt = BigInt(maker);
        const takerBigInt = BigInt(taker);
        const tokenBigInt = BigInt(token);

        console.log(`\n🔍 Address conversions for uint256 ABI:`);
        console.log(`   Maker: ${maker} -> ${makerBigInt}`);
        console.log(`   Taker: ${taker} -> ${takerBigInt}`);
        console.log(`   Token: ${token} -> ${tokenBigInt}`);

        // Build parameters exactly like DeployEscrowDst.s.sol
        const protocolFeeAmount = 0n
        const integratorFeeAmount = 0n
        const protocolFeeRecipient = account.address
        const integratorFeeRecipient = account.address

        // Encode parameters exactly like buildDstEscrowImmutables
        const parametersEncoded = `0x${[
            protocolFeeAmount.toString(16).padStart(64, '0'),
            integratorFeeAmount.toString(16).padStart(64, '0'),
            BigInt(protocolFeeRecipient).toString(16).padStart(64, '0'),
            BigInt(integratorFeeRecipient).toString(16).padStart(64, '0')
        ].join('')}` as `0x${string}`

        // Prepare the exact parameters from the working DeployEscrowDst.s.sol script
        const dstImmutables = {
            orderHash,
            hashlock,
            maker: makerBigInt,
            taker: takerBigInt,
            token: tokenBigInt,
            amount: dstAmount,
            safetyDeposit: safetyDeposit,
            timelocks: timelocks,
            parameters: parametersEncoded
        };

        // Send the transaction with VIEM
        const hash = await walletClient.writeContract({
            address: evmFactoryAddress,
            abi,
            functionName: 'createDstEscrow',
            args: [dstImmutables, srcCancellationTimestamp],
            value: requiredAmount
        });

        console.log(`\n📝 Transaction Details:`);
        console.log(`   Hash: ${hash}`);
        console.log(`   From: ${account.address}`);
        console.log(`   To: ${evmFactoryAddress}`);
        console.log(`   Value: ${requiredAmount} wei`);

        console.log(`\n⏳ Waiting for confirmation...`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        console.log(`\n✅ Transaction Successful!`);
        console.log(`   Block: ${receipt.blockNumber}`);
        console.log(`   Gas Used: ${receipt.gasUsed}`);
        console.log(`   Status: ${receipt.status}`);

        // Wait 2 seconds for proper indexing
        console.log(`\n⏳ Waiting 2 seconds for escrow object to be indexed...`);
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Parse the escrow address from the transaction logs
        let evmEscrowAddress = null;
        console.log(`\n🔍 Parsing Transaction Logs:`);
        console.log(`   Total logs: ${receipt.logs.length}`);

        // Look for DstEscrowCreated event
        for (const log of receipt.logs) {
            if (log.topics[0] === '0xc30e111dcc74fddc2c3a4d98ffb97adec4485c0a687946bf5b22c2a99c7ff96d') {
                // This is the DstEscrowCreated event topic from the successful forge script
                evmEscrowAddress = `0x${log.data.slice(26, 66)}`; // Extract address from data
                console.log(`   📍 Found DstEscrowCreated event!`);
                console.log(`   📍 Escrow Address: ${evmEscrowAddress}`);
                break;
            }
        }

        if (!evmEscrowAddress) {
            console.log(`\n⚠️  Could not parse escrow address from logs`);
            console.log(`🔍 All log topics:`);
            receipt.logs.forEach((log, index) => {
                console.log(`     Log ${index}: ${log.topics[0]}`);
            });
            throw new Error('Could not find escrow address in transaction logs');
        }

        console.log(`\n🎉 EVM Destination Escrow Deployment Complete!`);
        console.log(`   📍 Escrow Address: ${evmEscrowAddress}`);
        console.log(`   💰 Locked: ${dstAmount} wei + ${safetyDeposit} wei safety deposit`);
        console.log(`   🔐 Hashlock: ${hashlock}`);
        console.log(`   ✅ VIEM deployment successful!`);

        // Get the actual block timestamp and reconstruct immutables with correct timelocks
        const deploymentBlock = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
        const actualBlockTimestamp = Number(deploymentBlock.timestamp);

        console.log(`\n⏰ Timestamp Analysis:`);
        console.log(`   Script deployedAt: ${deployedAt}`);
        console.log(`   Actual block timestamp: ${actualBlockTimestamp}`);

        // The contract uses block.timestamp internally, so reconstruct timelocks with actual timestamp
        const actualTimelocks = packTimelocks(
            1,      // srcWithdrawal: immediate
            2000,   // srcPublicWithdrawal
            3000,   // srcCancellation
            4000,   // srcPublicCancellation
            1,      // dstWithdrawal: immediate (for testing)
            2000,   // dstPublicWithdrawal
            3000,   // dstCancellation
            actualBlockTimestamp  // Use actual block timestamp like the contract does
        );

        console.log(`\n🔄 Timelocks Correction:`);
        console.log(`   Original timelocks: ${timelocks}`);
        console.log(`   Actual timelocks:   ${actualTimelocks}`);

        // Create corrected immutables with actual timelocks
        const correctedImmutables = {
            ...dstImmutables,
            timelocks: actualTimelocks
        };

        return {
            escrowAddress: evmEscrowAddress,
            immutables: correctedImmutables,
            deployedAt: actualBlockTimestamp,
            factoryAddress: evmFactoryAddress
        };

    } catch (error: any) {
        console.error(`\n❌ Deployment Failed:`);
        console.error(`   Error: ${error.message}`);
        if (error.data) {
            console.error(`   Transaction Data: ${error.data}`);
        }
        throw error;
    }
}

/**
 * Test script to withdraw from EVM destination escrow using VIEM
 * This replicates the EXACT transaction from the successful WithdrawDst.s.sol script
 */
async function testDstEscrowWithdrawalViem(escrowAddress: string, deploymentImmutables: any, deployedAt: number, factoryAddress: string) {
    console.log('\n🔓 Testing EVM Destination Escrow Withdrawal with VIEM');
    console.log('='.repeat(60));

    // Initialize wallet and client with VIEM
    const bobEthPrivateKeyRaw = process.env.BOB_ETH_PRIVATE_KEY;
    if (!bobEthPrivateKeyRaw) {
        throw new Error('BOB_ETH_PRIVATE_KEY not found in environment variables');
    }

    const bobEthPrivateKey = bobEthPrivateKeyRaw.startsWith('0x')
        ? bobEthPrivateKeyRaw as `0x${string}`
        : `0x${bobEthPrivateKeyRaw}` as `0x${string}`;

    const account = privateKeyToAccount(bobEthPrivateKey);

    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
    });

    const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org')
    });

    console.log(`📋 Configuration:`);
    console.log(`   Provider: ${process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org'}`);
    console.log(`   Wallet: ${account.address}`);
    console.log(`   Escrow: ${escrowAddress}`);

    // Use the same secret generation as deployment
    const secret = keccak256(encodePacked(['string'], ['secret'])) as `0x${string}`;
    console.log(`\n🔐 Using EXACT same immutables from deployment:`);
    console.log(`   DeployedAt: ${deployedAt}`);
    console.log(`   OrderHash: ${deploymentImmutables.orderHash}`);
    console.log(`   Hashlock: ${deploymentImmutables.hashlock}`);
    console.log(`   Amount: ${deploymentImmutables.amount} wei`);
    console.log(`   SafetyDeposit: ${deploymentImmutables.safetyDeposit} wei`);
    console.log(`   Timelocks: ${deploymentImmutables.timelocks}`);
    console.log(`   Parameters: ${deploymentImmutables.parameters}`);

    console.log(`\n🔐 Withdrawal Parameters:`);
    console.log(`   Secret: ${secret}`);
    console.log(`   Using EXACT same immutables from deployment`);

    try {
        // Pack timelocks function (same as deployment) - using SDK's build() method order
        const packTimelocks = (
            srcWithdrawal: number, srcPublicWithdrawal: number, srcCancellation: number, srcPublicCancellation: number,
            dstWithdrawal: number, dstPublicWithdrawal: number, dstCancellation: number, deployedAt: number
        ): bigint => {
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
            ].reduce((acc, el) => (acc << 32n) | el)
        };

        // Use the actual factory that deployed this escrow (not hardcoded)
        const factory = factoryAddress as `0x${string}`; // Use the same factory from deployment
        const implementation = '0x3115126087c3A56cAA49E73fb153A01c524a6525' as `0x${string}`;

        // Compute proxyBytecodeHash like assembly in WithdrawDst.s.sol
        const proxyBytecode = encodePacked(
            ['bytes', 'address', 'bytes'],
            ['0x3d60e800600a3d3981f3363d3d373d3d3d363d73', implementation, '0x5af43d82803e903209b210156']
        );
        const proxyBytecodeHash = keccak256(proxyBytecode);

        // ABI types for immutables struct encoding
        const immutablesTypes = [
            { type: 'bytes32', name: 'orderHash' },
            { type: 'bytes32', name: 'hashlock' },
            { type: 'uint160', name: 'maker' },
            { type: 'uint160', name: 'taker' },
            { type: 'uint160', name: 'token' },
            { type: 'uint256', name: 'amount' },
            { type: 'uint256', name: 'safetyDeposit' },
            { type: 'uint256', name: 'timelocks' },
            { type: 'bytes', name: 'parameters' }
        ] as const;

        // Use the exact same immutables from deployment (the key is they must match!)
        const immutables = {
            ...deploymentImmutables
        };

        console.log(`\n📋 Using deployment immutables:`);
        console.log(`   Order Hash: ${immutables.orderHash}`);
        console.log(`   Hashlock: ${immutables.hashlock}`);
        console.log(`   Maker: ${immutables.maker}`);
        console.log(`   Taker: ${immutables.taker}`);
        console.log(`   Amount: ${immutables.amount} wei`);
        console.log(`   Safety Deposit: ${immutables.safetyDeposit} wei`);
        console.log(`   Timelocks: ${immutables.timelocks}`);
        console.log(`   Parameters: ${immutables.parameters}`);

        console.log(`\n🔄 Calling withdraw with secret and immutables...`);

        // Use the EXACT ABI from the working WithdrawDst.s.sol script
        const abi = [
            {
                inputs: [
                    { name: "secret", type: "bytes32" },
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
                        name: "immutables",
                        type: "tuple"
                    }
                ],
                name: "withdraw",
                outputs: [],
                stateMutability: "nonpayable",
                type: "function"
            },
            {
                name: "InvalidImmutables",
                type: "error"
            }
        ] as const;

        // First simulate to get specific error
        try {
            const simulation = await publicClient.simulateContract({
                address: escrowAddress as `0x${string}`,
                abi,
                functionName: 'withdraw',
                args: [secret, immutables],
                account: account.address
            });
            console.log('✅ Simulation successful, proceeding with actual transaction...');
        } catch (simError) {
            console.log('❌ Simulation failed with specific error:', simError);
            throw simError;
        }

        // Call withdraw function with secret and immutables
        const hash = await walletClient.writeContract({
            address: escrowAddress as `0x${string}`,
            abi,
            functionName: 'withdraw',
            args: [secret, immutables],
            account: account
        });

        console.log(`\n📤 Transaction sent: ${hash}`);
        console.log(`⏳ Waiting for confirmation...`);

        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        console.log(`\n✅ Withdrawal Successful!`);
        console.log(`   Block: ${receipt.blockNumber}`);
        console.log(`   Gas Used: ${receipt.gasUsed}`);
        console.log(`   Status: ${receipt.status}`);

        console.log(`\n🎉 EVM Destination Escrow Withdrawal Complete!`);
        console.log(`   📍 Escrow Address: ${escrowAddress}`);
        console.log(`   💰 Withdrawn: ${immutables.amount} wei + ${immutables.safetyDeposit} wei safety deposit`);
        console.log(`   🔐 Secret: ${secret}`);
        console.log(`   ✅ VIEM withdrawal successful!`);

        return true;

    } catch (error: any) {
        console.error(`\n❌ Withdrawal Failed:`);
        console.error(`   Error: ${error.message}`);
        if (error.data) {
            console.error(`   Transaction Data: ${error.data}`);
        }
        throw error;
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    console.log('\n🚀 Testing FULL DST Escrow Flow (Deployment + Withdrawal)...');

    testDstEscrowDeploymentViem()
        .then(async (deploymentResult) => {
            console.log(`\n✅ Deployment completed successfully!`);
            console.log(`📍 Escrow Address: ${deploymentResult.escrowAddress}`);

            // Wait a bit before attempting withdrawal
            console.log(`\n⏳ Waiting 5 seconds before attempting withdrawal...`);
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Now attempt withdrawal with the deployed escrow
            await testDstEscrowWithdrawalViem(
                deploymentResult.escrowAddress,
                deploymentResult.immutables,
                deploymentResult.deployedAt,
                deploymentResult.factoryAddress
            );

            console.log(`\n🎉 Complete VIEM test (deployment + withdrawal) successful!`);
            process.exit(0);
        })
        .catch((error) => {
            console.error(`\n❌ VIEM test failed:`, error);
            process.exit(1);
        });
}

export { testDstEscrowDeploymentViem, testDstEscrowWithdrawalViem };