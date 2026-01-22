import {
	BYTES32_ZERO,
	type chain,
	chainMap,
	clients,
	getChainName,
	getOracle,
	INPUT_SETTLER_COMPACT_LIFI,
	INPUT_SETTLER_ESCROW_LIFI,
	T1_ORACLE,
	type WC
} from "$lib/config";
import { encodeAbiParameters, maxUint256, parseAbiParameters } from "viem";
import type { MandateOutput, OrderContainer } from "../../types";
import { addressToBytes32, bytes32ToAddress } from "$lib/utils/convert";
import axios from "axios";
import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
import { T1_ORACLE_ABI } from "$lib/abi/t1oracle";
import { SETTLER_COMPACT_ABI } from "$lib/abi/settlercompact";
import { COIN_FILLER_ABI } from "$lib/abi/outputsettler";
import { ERC20_ABI } from "$lib/abi/erc20";
import { getOrderId } from "$lib/utils/orderLib";
import { SETTLER_ESCROW_ABI } from "$lib/abi/escrow";

/**
 * @notice Class for solving intents. Functions called by solvers.
 */
export class Solver {
	static fill(
		walletClient: WC,
		args: {
			orderContainer: OrderContainer;
			outputs: MandateOutput[];
		},
		opts: {
			preHook?: (chain: chain) => Promise<any>;
			postHook?: () => Promise<any>;
			account: () => `0x${string}`;
		}
	) {
		return async () => {
			const { preHook, postHook, account } = opts;
			const {
				orderContainer: { order, inputSettler },
				outputs
			} = args;
			const publicClients = clients;
			const orderId = getOrderId({ order, inputSettler });
			//Check that only 1 output exists.
			if (outputs.length !== 1) {
				throw new Error("Order must have exactly one output");
			}

			const outputChain = getChainName(outputs[0].chainId);
			console.log("Solver.fill started:", { outputChain, orderId });
			try {
				for (const output of outputs) {
					if (output.token === BYTES32_ZERO) {
						// The destination asset cannot be ETH.
						throw new Error("Output token cannot be ETH");
					}
					if (output.chainId != outputs[0].chainId) {
						throw new Error("Filling outputs on multiple chains with single fill call not supported");
					}
					if (output.settler != outputs[0].settler) {
						throw new Error("Different settlers on outputs, not supported");
					}

					// Check allowance & set allowance if needed
					const assetAddress = bytes32ToAddress(output.token);
					console.log("Solver.fill checking allowance:", { assetAddress, account: account() });
					const allowance = await publicClients[outputChain].readContract({
						address: assetAddress,
						abi: ERC20_ABI,
						functionName: "allowance",
						args: [account(), bytes32ToAddress(output.settler)]
					});
					console.log("Solver.fill allowance:", { allowance, needed: output.amount });
					if (preHook) await preHook(outputChain);
					if (BigInt(allowance) < output.amount) {
						console.log("Solver.fill requesting approval...");
						const approveTransaction = await walletClient.writeContract({
							chain: chainMap[outputChain],
							account: account(),
							address: assetAddress,
							abi: ERC20_ABI,
							functionName: "approve",
							args: [bytes32ToAddress(output.settler), maxUint256]
						});
						console.log("Solver.fill approval tx:", approveTransaction);
						await clients[outputChain].waitForTransactionReceipt({
							hash: approveTransaction
						});
					}
				}

				console.log("Solver.fill calling fillOrderOutputs...");
				const transactionHash = await walletClient.writeContract({
					chain: chainMap[outputChain],
					account: account(),
					address: bytes32ToAddress(outputs[0].settler),
					abi: COIN_FILLER_ABI,
					functionName: "fillOrderOutputs",
					args: [orderId, outputs, order.fillDeadline, addressToBytes32(account())]
				});
				console.log("Solver.fill tx submitted:", transactionHash);
				await clients[outputChain].waitForTransactionReceipt({
					hash: transactionHash
				});
				console.log("Solver.fill completed successfully");
				// orderInputs.validate[index] = transcationHash;
				if (postHook) await postHook();
				return transactionHash;
			} catch (err) {
				console.error("Solver.fill error:", err);
				throw err;
			}
		};
	}

	static validate(
		walletClient: WC,
		args: { orderContainer: OrderContainer; fillTransactionHash: string; mainnet: boolean },
		opts: {
			preHook?: (chain: chain) => Promise<any>;
			postHook?: () => Promise<any>;
			account: () => `0x${string}`;
		}
	) {
		return async () => {
			const { preHook, postHook, account } = opts;
			const {
				orderContainer: { order, inputSettler },
				fillTransactionHash,
				mainnet
			} = args;
			const sourceChain = getChainName(order.originChainId);
			const outputChain = getChainName(order.outputs[0].chainId);
			if (order.outputs.length !== 1) {
				throw new Error("Order must have exactly one output");
			}
			// The destination asset cannot be ETH.
			const output = order.outputs[0];

			if (order.inputOracle === getOracle("polymer", sourceChain)) {
				const transactionReceipt = await clients[outputChain].getTransactionReceipt({
					hash: fillTransactionHash as `0x${string}`
				});

				const numlogs = transactionReceipt.logs.length;
				if (numlogs !== 2) throw Error(`Unexpected Logs count ${numlogs}`);
				const fillLog = transactionReceipt.logs[1]; // The first log is transfer, next is fill.

				let proof: string | undefined;
				let polymerIndex: number | undefined;
				for (let i = 0; i < 5; ++i) {
					const response = await axios.post(`/polymer`, {
						srcChainId: Number(order.outputs[0].chainId),
						srcBlockNumber: Number(transactionReceipt.blockNumber),
						globalLogIndex: Number(fillLog.logIndex),
						polymerIndex,
						mainnet: mainnet
					});
					const dat = response.data as {
						proof: undefined | string;
						polymerIndex: number;
					};
					polymerIndex = dat.polymerIndex;
					console.log(dat);
					if (dat.proof) {
						proof = dat.proof;
						break;
					}
					// Wait while backing off before requesting again.
					await new Promise((r) => setTimeout(r, i * 2 + 1000));
				}
				console.log({ proof });
				if (proof) {
					if (preHook) await preHook(sourceChain);

					const transcationHash = await walletClient.writeContract({
						chain: chainMap[sourceChain],
						account: account(),
						address: order.inputOracle,
						abi: POLYMER_ORACLE_ABI,
						functionName: "receiveMessage",
						args: [`0x${proof.replace("0x", "")}`]
					});

					const result = await clients[sourceChain].waitForTransactionReceipt({
						hash: transcationHash
					});
					if (postHook) await postHook();
					return result;
				}
			}

			if (order.inputOracle === getOracle("t1", sourceChain)) {
				// t1 proof validation - request proof via POST, then poll GET for result
				const t1OracleAddress = T1_ORACLE[sourceChain];
				const output = order.outputs[0];
				const orderId = getOrderId({ order, inputSettler });

				console.log("t1 validation started:", {
					sourceChain,
					outputChain,
					t1OracleAddress,
					orderInputOracle: order.inputOracle,
					outputChainId: Number(output.chainId),
					originChainId: Number(order.originChainId),
					orderId,
					outputSettler: bytes32ToAddress(output.settler)
				});

				// First, POST to request a proof
				const postPayload = {
					destinationDomain: Number(output.chainId),
					targetContract: bytes32ToAddress(output.settler),
					orderId,
					output,
					requester: t1OracleAddress
				};
				console.log("t1 POST request payload:", postPayload);

				try {
					const postResponse = await axios.post(`/t1`, postPayload);
					console.log("t1 POST response:", postResponse.data);
				} catch (err) {
					console.error("t1 POST request failed:", err);
				}

				// Then poll GET for the proof
				let proofCalldata: string | undefined;
				for (let i = 0; i < 10; ++i) {
					// Query t1 API for existing proofs
					// Direction is from origin chain (where intent was created) to output chain (where fill happened)
					// Address is the t1 oracle on the origin chain (the requester)
					const queryParams = {
						address: t1OracleAddress,
						srcChainId: Number(order.originChainId),
						dstChainId: Number(output.chainId)
					};
					console.log(`t1 GET query attempt ${i + 1}/10:`, queryParams);

					const response = await axios.get(`/t1`, { params: queryParams });
					const dat = response.data as {
						proof: string | undefined;
						requestId: string | undefined;
						status: string;
						debug?: any;
					};
					console.log("t1 GET query response:", dat);

					if (dat.proof && dat.status === "complete") {
						proofCalldata = dat.proof;
						break;
					}
					// Wait with exponential backoff before querying again
					await new Promise((r) => setTimeout(r, (i + 1) * 2000));
				}

				console.log({ t1ProofCalldata: proofCalldata });

				if (proofCalldata) {
					if (preHook) await preHook(sourceChain);

					// Submit the proof calldata to the t1 oracle
					const transactionHash = await walletClient.writeContract({
						chain: chainMap[sourceChain],
						account: account(),
						address: order.inputOracle,
						abi: T1_ORACLE_ABI,
						functionName: "handleReadResultWithProof",
						args: [`0x${proofCalldata.replace("0x", "")}`]
					});

					const result = await clients[sourceChain].waitForTransactionReceipt({
						hash: transactionHash
					});
					if (postHook) await postHook();
					return result;
				}
			}

			// if (order.inputOracle === getOracle("wormhole", sourceChain)) {
			// 	// TODO: get sequence from event.
			// 	const sequence = 0;
			// 	// Get VAA
			// 	const wormholeChainId = wormholeChainIds[outputChain];
			// 	const requestUrl = `https://api.testnet.wormholescan.io/v1/signed_vaa/${wormholeChainId}/${output.oracle.replace(
			// 		"0x",
			// 		""
			// 	)}/${sequence}?network=Testnet`;
			// 	const response = await axios.get(requestUrl);
			// 	console.log(response.data);
			// return $walletClient.writeContract({
			// 	account: connectedAccount.address,
			// 	address: order.inputOracle,
			// 	abi: WROMHOLE_ORACLE_ABI,
			// 	functionName: 'receiveMessage',
			// 	args: [encodedOutput]
			// });
			// 	return;
			// }
		};
	}

	static claim(
		walletClient: WC,
		args: {
			orderContainer: OrderContainer;
			fillTransactionHash: string;
		},
		opts: {
			preHook?: (chain: chain) => Promise<any>;
			postHook?: () => Promise<any>;
			account: () => `0x${string}`;
		}
	) {
		return async () => {
			const { preHook, postHook, account } = opts;
			const { orderContainer, fillTransactionHash } = args;
			const { order } = orderContainer;
			const outputChain = getChainName(order.outputs[0].chainId);
			if (order.outputs.length !== 1) {
				throw new Error("Order must have exactly one output");
			}
			const transactionReceipt = await clients[outputChain].getTransactionReceipt({
				hash: fillTransactionHash as `0x${string}`
			});
			const blockHashOfFill = transactionReceipt.blockHash;
			const block = await clients[outputChain].getBlock({
				blockHash: blockHashOfFill
			});
			const fillTimestamp = block.timestamp;

			const sourceChain = getChainName(order.originChainId);
			if (preHook) await preHook(sourceChain);

			const inputSettler = orderContainer.inputSettler;
			console.log({ orderContainer });
			let transactionHash: `0x${string}`;
			const actionChain = chainMap[sourceChain];

			const solveParam = {
				timestamp: Number(fillTimestamp),
				solver: addressToBytes32(account())
			};

			if (inputSettler.toLowerCase() === INPUT_SETTLER_ESCROW_LIFI.toLowerCase()) {
				transactionHash = await walletClient.writeContract({
					chain: actionChain,
					account: account(),
					address: inputSettler,
					abi: SETTLER_ESCROW_ABI,
					functionName: "finalise",
					args: [order, [solveParam], addressToBytes32(account()), "0x"]
				});
			} else if (inputSettler.toLowerCase() === INPUT_SETTLER_COMPACT_LIFI.toLowerCase()) {
				// Check whether or not we have a signature.
				const { sponsorSignature, allocatorSignature } = orderContainer;
				console.log({
					sponsorSignature,
					allocatorSignature
				});
				const combinedSignatures = encodeAbiParameters(parseAbiParameters(["bytes", "bytes"]), [
					sponsorSignature.payload ?? "0x",
					allocatorSignature.payload
				]);
				transactionHash = await walletClient.writeContract({
					chain: actionChain,
					account: account(),
					address: inputSettler,
					abi: SETTLER_COMPACT_ABI,
					functionName: "finalise",
					args: [order, combinedSignatures, [solveParam], addressToBytes32(account()), "0x"]
				});
			} else {
				throw new Error(`Could not detect settler type ${orderContainer.inputSettler}`);
			}
			const result = await clients[sourceChain].waitForTransactionReceipt({
				hash: transactionHash
			});
			if (postHook) await postHook();
			return result;
		};
	}
}
