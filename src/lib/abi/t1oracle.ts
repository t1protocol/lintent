/**
 * T1Oracle ABI for OIF cross-chain proof attestation
 *
 * T1Oracle proves intent fills by verifying xChainRead proofs from a TEE.
 * The solver must provide the preimage (solver, timestamp) to prove they filled the intent.
 *
 * Contract addresses:
 * - Arbitrum: 0xf0448b81bc9d1adffbcb34b856d73174dba03eb5
 * - Base: 0xe0f3ec825b60f952343c07e472087a85f6a4eb7e
 */
export const T1_ORACLE_ABI = [
	{
		type: "function",
		name: "receiveMessageWithPreimage",
		inputs: [
			{ name: "proof", type: "bytes", internalType: "bytes" },
			{ name: "remoteChainId", type: "uint32", internalType: "uint32" },
			{ name: "solver", type: "bytes32", internalType: "bytes32" },
			{ name: "timestamp", type: "uint32", internalType: "uint32" },
			{ name: "orderId", type: "bytes32", internalType: "bytes32" },
			{
				name: "output",
				type: "tuple",
				internalType: "struct MandateOutput",
				components: [
					{ name: "oracle", type: "bytes32", internalType: "bytes32" },
					{ name: "settler", type: "bytes32", internalType: "bytes32" },
					{ name: "chainId", type: "uint256", internalType: "uint256" },
					{ name: "token", type: "bytes32", internalType: "bytes32" },
					{ name: "amount", type: "uint256", internalType: "uint256" },
					{ name: "recipient", type: "bytes32", internalType: "bytes32" },
					{ name: "callbackData", type: "bytes", internalType: "bytes" },
					{ name: "context", type: "bytes", internalType: "bytes" }
				]
			}
		],
		outputs: [],
		stateMutability: "nonpayable"
	},
	{
		type: "function",
		name: "isProven",
		inputs: [
			{ name: "remoteChainId", type: "uint256", internalType: "uint256" },
			{ name: "remoteOracle", type: "bytes32", internalType: "bytes32" },
			{ name: "application", type: "bytes32", internalType: "bytes32" },
			{ name: "dataHash", type: "bytes32", internalType: "bytes32" }
		],
		outputs: [{ name: "", type: "bool", internalType: "bool" }],
		stateMutability: "view"
	},
	{
		type: "event",
		name: "OutputProven",
		inputs: [
			{ name: "remoteChainId", type: "uint256", indexed: true, internalType: "uint256" },
			{ name: "oracleIdentifier", type: "bytes32", indexed: true, internalType: "bytes32" },
			{ name: "applicationIdentifier", type: "bytes32", indexed: true, internalType: "bytes32" },
			{ name: "payloadHash", type: "bytes32", indexed: false, internalType: "bytes32" }
		],
		anonymous: false
	},
	{
		type: "error",
		name: "InvalidPreimage",
		inputs: [
			{ name: "expected", type: "bytes32", internalType: "bytes32" },
			{ name: "provided", type: "bytes32", internalType: "bytes32" }
		]
	},
	{
		type: "error",
		name: "IntentNotFilled",
		inputs: []
	}
] as const;
