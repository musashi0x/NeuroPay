// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title NeuroPay Test USD
/// @notice A payment token for integration testing, with an open mint.
///
/// @dev ## Why this exists
///
/// The address previously configured as the payment token is an ERC-20
/// whose `mint` is owner-gated by a third party, and the public BNB
/// faucet gates claims behind mainnet BNB and a once-per-day limit. Both
/// make funding a test wallet something a human has to go do by hand,
/// which is a poor foundation for a loop that is supposed to be
/// repeatable.
///
/// So this token has **no mint authority at all**. Anyone can mint any
/// amount to any address. That is not an oversight — it is the entire
/// point, and restricting it would recreate the problem it was written
/// to solve.
///
/// ## The guard that makes that safe
///
/// A freely-mintable token is worthless by construction, and worthless
/// is exactly right for a testnet. It would be a disaster on a network
/// where anyone might mistake it for value, so the constructor refuses
/// to deploy on a chain id known to be a production network. A test
/// artifact that *cannot* be deployed to mainnet is a stronger guarantee
/// than a comment asking people not to.
///
/// The name and symbol are deliberately not `USDT`. A self-minted token
/// wearing the ticker of a real stablecoin is the kind of thing that
/// ends up screenshotted out of context.
contract NeuroPayTestUSD {
    string public constant name = "NeuroPay Test USD";
    string public constant symbol = "npUSD";

    /// @dev 18, matching the token this replaces, so no cap, threshold,
    /// or price in the existing configuration has to be rescaled.
    uint8 public constant decimals = 18;

    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ProductionChain(uint256 chainId);
    error InsufficientBalance(uint256 available, uint256 required);
    error InsufficientAllowance(uint256 available, uint256 required);

    constructor() {
        // Refuse the chain ids of networks where a free mint would be
        // mistaken for value. Not exhaustive, and not meant to be: it
        // stops the realistic accident, which is a deploy script run
        // with the wrong RPC.
        uint256 id = block.chainid;
        if (id == 1 || id == 56 || id == 137 || id == 8453 || id == 42161 || id == 10) {
            revert ProductionChain(id);
        }
    }

    /// @notice Mint `amount` to `to`. Unrestricted, on purpose.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        // An infinite approval is not decremented. Permit2 holds exactly
        // that, and decrementing it would make every settlement pay for
        // a storage write it does not need.
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance(allowed, amount);
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
