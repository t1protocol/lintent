/**
 * t1 Oracle ABI for handling cross-chain read proofs
 * The main function is handleReadResultWithProof which receives the encoded proof data
 * Method ID: c106dee5
 */
export const T1_ORACLE_ABI = [
	{
		type: "function",
		name: "handleReadResultWithProof",
		inputs: [{ name: "encodedProofOfRead", type: "bytes", internalType: "bytes" }],
		outputs: [],
		stateMutability: "nonpayable"
	}
] as const;
