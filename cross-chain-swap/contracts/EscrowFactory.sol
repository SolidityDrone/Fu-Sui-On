// SPDX-License-Identifier: MIT

pragma solidity 0.8.23;

import { IERC20 } from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

import { SimpleSettlement } from "limit-order-settlement/contracts/SimpleSettlement.sol";

import { ProxyHashLib } from "./libraries/ProxyHashLib.sol";

import { BaseEscrowFactory } from "./BaseEscrowFactory.sol";
import { EscrowDst } from "./EscrowDst.sol";
import { EscrowSrc } from "./EscrowSrc.sol";
import { MerkleStorageInvalidator } from "./MerkleStorageInvalidator.sol";


/**
 * @title Escrow Factory contract
 * @notice Contract to create escrow contracts for cross-chain atomic swap.
 * @custom:security-contact security@1inch.io
 */
contract EscrowFactory is BaseEscrowFactory {
    constructor(
        address limitOrderProtocol,
        IERC20 accessToken,
        address owner,
        uint32 rescueDelaySrc,
        uint32 rescueDelayDst
    )
    SimpleSettlement(limitOrderProtocol, accessToken, address(0), owner)
    MerkleStorageInvalidator(limitOrderProtocol) {
        ESCROW_SRC_IMPLEMENTATION = address(new EscrowSrc(rescueDelaySrc, accessToken));
        ESCROW_DST_IMPLEMENTATION = address(new EscrowDst(rescueDelayDst, accessToken));
        _PROXY_SRC_BYTECODE_HASH = ProxyHashLib.computeProxyBytecodeHash(ESCROW_SRC_IMPLEMENTATION);
        _PROXY_DST_BYTECODE_HASH = ProxyHashLib.computeProxyBytecodeHash(ESCROW_DST_IMPLEMENTATION);
    }
}
