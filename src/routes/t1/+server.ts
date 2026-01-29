import { json } from "@sveltejs/kit";
import axios from "axios";
import type { RequestHandler } from "./$types";
import { encodeFunctionData } from "viem";

const T1_API_URL = "https://proofofread.api.t1protocol.com";

/**
 * Direction mapping for t1 API
 * Maps source chain ID -> destination chain ID -> direction string
 */
const DIRECTION_MAP: Record<number, Record<number, string>> = {
	// Arbitrum (42161) as source
	42161: {
		8453: "ARB_TO_BASE", // Arbitrum -> Base
		1: "ARB_TO_ETH" // Arbitrum -> Ethereum
	},
	// Base (8453) as source
	8453: {
		42161: "BASE_TO_ARB", // Base -> Arbitrum
		1: "BASE_TO_ETH" // Base -> Ethereum
	},
	// Ethereum (1) as source
	1: {
		42161: "ETH_TO_ARB", // Ethereum -> Arbitrum
		8453: "ETH_TO_BASE" // Ethereum -> Base
	}
};

// ABI for getFillRecord function on output settler
const GET_FILL_RECORD_ABI = [
	{
		type: "function",
		name: "getFillRecord",
		stateMutability: "view",
		inputs: [
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
		outputs: [{ name: "payloadHash", type: "bytes32", internalType: "bytes32" }]
	}
] as const;

function getDirection(srcChainId: number, dstChainId: number): string | undefined {
	return DIRECTION_MAP[srcChainId]?.[dstChainId];
}

export const POST: RequestHandler = async ({ request }) => {
	const { destinationDomain, targetContract, orderId, output, requester, callData: providedCallData } =
		await request.json();

	console.log("t1 POST received:", {
		destinationDomain,
		targetContract,
		orderId,
		output,
		requester,
		providedCallData
	});

	// Generate callData if not provided but orderId and output are
	let callData = providedCallData;
	if (!callData && orderId && output) {
		try {
			callData = encodeFunctionData({
				abi: GET_FILL_RECORD_ABI,
				functionName: "getFillRecord",
				args: [orderId, output]
			});
			console.log("t1 generated callData:", callData);
		} catch (err) {
			console.error("t1 failed to encode callData:", err);
			return json(
				{
					error: "Failed to encode callData",
					status: "error"
				},
				{ status: 400 }
			);
		}
	}

	if (!callData) {
		return json(
			{
				error: "callData is required (either directly or via orderId + output)",
				status: "error"
			},
			{ status: 400 }
		);
	}

	const payload = {
		destinationDomain,
		targetContract,
		callData,
		requester
	};
	console.log("t1 POST to API:", payload);

	try {
		const response = await axios.post(`${T1_API_URL}/api/read-proofs`, payload, {
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json"
			}
		});

		console.log("t1 API response:", response.data);

		return json({
			txHash: response.data.txHash,
			status: "requested",
			callData,
			debug: { payload, response: response.data }
		});
	} catch (error: any) {
		console.error("t1 proof request error:", error?.response?.data ?? error);
		return json(
			{
				error: "Failed to request t1 proof",
				status: "error",
				debug: { payload, errorData: error?.response?.data }
			},
			{ status: 500 }
		);
	}
};

export const GET: RequestHandler = async ({ url }) => {
	const address = url.searchParams.get("address");
	const srcChainId = url.searchParams.get("srcChainId");
	const dstChainId = url.searchParams.get("dstChainId");
	const orderId = url.searchParams.get("orderId");
	const targetContract = url.searchParams.get("targetContract");
	const page = url.searchParams.get("page") ?? "1";
	const pageSize = url.searchParams.get("pageSize") ?? "100";

	console.log("t1 GET request params:", { address, srcChainId, dstChainId, orderId, targetContract, page, pageSize });

	// Determine direction from chain IDs
	let direction: string | undefined;
	if (srcChainId && dstChainId) {
		direction = getDirection(Number(srcChainId), Number(dstChainId));
	}
	console.log("t1 direction:", direction);

	// The T1 API requires an address parameter (filters by messageSender)
	// Note: The API filters by messageSender which is the postman service's signer
	// not the T1Oracle address. If we query with T1Oracle address, we may get 0 results.
	// We still make the call and filter by orderId, relying on on-chain verification as backup.
	if (!address) {
		return json({
			proof: undefined,
			requestId: undefined,
			status: "pending",
			results: [],
			total: 0,
			debug: {
				message: "Address parameter required by T1 API",
				note: "Use on-chain T1Oracle.isProven() for verification"
			}
		});
	}

	try {
		const params = new URLSearchParams({
			address,
			page,
			page_size: pageSize
		});

		if (direction) {
			params.append("direction", direction);
		}

		const apiUrl = `${T1_API_URL}/api/read-proofs?${params.toString()}`;
		console.log("t1 API URL:", apiUrl);

		const response = await axios.get(apiUrl, {
			headers: {
				Accept: "application/json"
			}
		});

		const data = response.data;
		console.log("t1 raw API response:", JSON.stringify(data, null, 2));

		let results = data.data?.results ?? [];

		// Filter results by orderId if provided
		// The orderId appears in the callData (message field) as part of getFillRecord encoding
		if (orderId && results.length > 0) {
			const orderIdNormalized = orderId.toLowerCase().replace("0x", "");
			results = results.filter((r: any) => {
				const message = r.claim_info?.message?.toLowerCase() ?? "";
				// The callData contains the orderId as a bytes32 parameter
				return message.includes(orderIdNormalized);
			});
			console.log(`t1 filtered by orderId ${orderId}: ${results.length} results`);
		}

		// Filter by targetContract if provided
		if (targetContract && results.length > 0) {
			const targetNormalized = targetContract.toLowerCase();
			results = results.filter((r: any) => {
				const to = r.claim_info?.to?.toLowerCase() ?? "";
				return to === targetNormalized;
			});
			console.log(`t1 filtered by targetContract ${targetContract}: ${results.length} results`);
		}

		// Get the most recent matching proof
		const latestProof = results.length > 0 ? results[0] : null;

		const result = {
			proof: latestProof?.claim_info?.handle_read_result_with_proof_calldata,
			requestId: latestProof?.claim_info?.request_id,
			status: latestProof ? "complete" : "pending",
			results,
			total: results.length,
			// Debug info
			debug: {
				address,
				srcChainId,
				dstChainId,
				orderId,
				targetContract,
				direction,
				apiUrl,
				rawTotal: data.data?.total,
				rawResultsCount: data.data?.results?.length ?? 0,
				filteredResultsCount: results.length
			}
		};

		return json(result);
	} catch (error) {
		console.error("t1 proof query error:", error);
		return json(
			{
				error: "Failed to query t1 proofs",
				status: "error",
				debug: { address, srcChainId, dstChainId, orderId, direction }
			},
			{ status: 500 }
		);
	}
};
