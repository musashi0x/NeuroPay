/**
 * Compiled artifact for `contracts/NeuroPayTestUSD.sol`.
 *
 * Generated — do not edit by hand. Regenerate with:
 *
 *   pnpm --filter @neuro-pay/evm-testnet build:token
 *
 * Checked in on purpose. Deploying should not require a Solidity
 * toolchain: the compile happens once, on a machine that has one, and
 * everyone else deploys the exact bytes that were reviewed. It also
 * means the deploy script has no build step between reading the
 * artifact and broadcasting it.
 *
 * Compiler: solc 0.8.24+commit.e11b9ed9 (optimizer on, 200 runs)
 */

import type { Hex } from "@neuro-pay/types";

export const TEST_TOKEN_ABI = [
  {
    type: "constructor",
    inputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      {
        name: "spender",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "decimals",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "mint",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "name",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "symbol",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "string",
        internalType: "string",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "totalSupply",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "transfer",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferFrom",
    inputs: [
      {
        name: "from",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      {
        name: "owner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "spender",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      {
        name: "from",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "value",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "InsufficientAllowance",
    inputs: [
      {
        name: "available",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "required",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [
      {
        name: "available",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "required",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "ProductionChain",
    inputs: [
      {
        name: "chainId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
] as const;

export const TEST_TOKEN_BYTECODE: Hex =
  "0x608060405234801561000f575f80fd5b504660018114806100205750806038145b8061002b5750806089145b80610037575080612105145b8061004357508061a4b1145b8061004e575080600a145b1561007357604051635023baeb60e11b81526004810182905260240160405180910390fd5b50610580806100815f395ff3fe608060405234801561000f575f80fd5b506004361061009b575f3560e01c806340c10f191161006357806340c10f191461014b57806370a082311461016057806395d89b411461017f578063a9059cbb146101a3578063dd62ed3e146101b6575f80fd5b806306fdde031461009f578063095ea7b3146100e557806318160ddd1461010857806323b872dd1461011e578063313ce56714610131575b5f80fd5b6100cf6040518060400160405280601181526020017013995d5c9bd4185e4815195cdd081554d1607a1b81525081565b6040516100dc9190610412565b60405180910390f35b6100f86100f3366004610479565b6101e0565b60405190151581526020016100dc565b6101105f5481565b6040519081526020016100dc565b6100f861012c3660046104a1565b61024c565b610139601281565b60405160ff90911681526020016100dc565b61015e610159366004610479565b6102e5565b005b61011061016e3660046104da565b60016020525f908152604090205481565b6100cf604051806040016040528060058152602001641b9c1554d160da1b81525081565b6100f86101b1366004610479565b61034d565b6101106101c43660046104fa565b600260209081525f928352604080842090915290825290205481565b335f8181526002602090815260408083206001600160a01b038716808552925280832085905551919290917f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259061023a9086815260200190565b60405180910390a35060015b92915050565b6001600160a01b0383165f9081526002602090815260408083203384529091528120545f1981146102cf57828110156102a75760405163054365bb60e31b815260048101829052602481018490526044015b60405180910390fd5b6001600160a01b0385165f908152600260209081526040808320338452909152902083820390555b6102da858585610362565b506001949350505050565b805f808282546102f5919061052b565b90915550506001600160a01b0382165f818152600160209081526040808320805486019055518481527fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef910160405180910390a35050565b5f610359338484610362565b50600192915050565b6001600160a01b0383165f90815260016020526040902054818110156103a55760405163cf47918160e01b8152600481018290526024810183905260440161029e565b6001600160a01b038085165f8181526001602052604080822086860390559286168082529083902080548601905591517fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef906104049086815260200190565b60405180910390a350505050565b5f602080835283518060208501525f5b8181101561043e57858101830151858201604001528201610422565b505f604082860101526040601f19601f8301168501019250505092915050565b80356001600160a01b0381168114610474575f80fd5b919050565b5f806040838503121561048a575f80fd5b6104938361045e565b946020939093013593505050565b5f805f606084860312156104b3575f80fd5b6104bc8461045e565b92506104ca6020850161045e565b9150604084013590509250925092565b5f602082840312156104ea575f80fd5b6104f38261045e565b9392505050565b5f806040838503121561050b575f80fd5b6105148361045e565b91506105226020840161045e565b90509250929050565b8082018082111561024657634e487b7160e01b5f52601160045260245ffdfea2646970667358221220c63f91f4a906ad3b16c999f5d1690b6dd481eb2c2df62d07e2f445a054d5e2d464736f6c63430008180033";

/** Matches the constants in the contract. */
export const TEST_TOKEN_METADATA = {
  name: "NeuroPay Test USD",
  symbol: "npUSD",
  decimals: 18,
} as const;
