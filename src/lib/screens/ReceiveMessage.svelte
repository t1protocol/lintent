<script lang="ts">
	import {
		formatTokenAmount,
		getChainName,
		getClient,
		getCoin,
		getOracle,
		type chain,
		type WC
	} from "$lib/config";
	import { addressToBytes32 } from "$lib/utils/convert";
	import { encodeMandateOutput, getOrderId } from "$lib/utils/orderLib";
	import { keccak256 } from "viem";
	import type { MandateOutput, OrderContainer } from "../../types";
	import { POLYMER_ORACLE_ABI } from "$lib/abi/polymeroracle";
	import { Solver } from "$lib/libraries/solver";
	import AwaitButton from "$lib/components/AwaitButton.svelte";
	import axios from "axios";

	// This script needs to be updated to be able to fetch the associated events of fills. Currently, this presents an issue since it can only fill single outputs.

	let {
		orderContainer,
		walletClient,
		fillTransactionHash,
		account,
		preHook,
		postHook,
		mainnet
	}: {
		orderContainer: OrderContainer;
		walletClient: WC;
		fillTransactionHash: `0x${string}`;
		preHook?: (chain: chain) => Promise<any>;
		postHook: () => Promise<any>;
		account: () => `0x${string}`;
		mainnet: boolean;
	} = $props();

	let refreshValidation = $state(0);
	const postHookRefreshValidate = async () => {
		await postHook();
		refreshValidation += 1;
	};

	async function isValidated(
		orderId: `0x${string}`,
		orderContainer: OrderContainer,
		output: MandateOutput,
		fillTransactionHash: `0x${string}`,
		_?: any
	) {
		if (
			!fillTransactionHash ||
			!fillTransactionHash.startsWith("0x") ||
			fillTransactionHash.length != 66
		)
			return false;
		const { order } = orderContainer;
		const sourceChain = getChainName(order.originChainId);

		// Check if this is a t1 oracle - use API query instead of isProven
		const t1Oracle = getOracle("t1", sourceChain);
		console.log("isValidated check:", {
			orderInputOracle: order.inputOracle,
			t1Oracle,
			sourceChain,
			isT1: t1Oracle && order.inputOracle.toLowerCase() === t1Oracle.toLowerCase()
		});

		if (t1Oracle && order.inputOracle.toLowerCase() === t1Oracle.toLowerCase()) {
			try {
				// Direction is from origin chain (where intent was created) to output chain (where fill happened)
				const queryParams = {
					address: order.inputOracle,
					srcChainId: Number(order.originChainId),
					dstChainId: Number(output.chainId)
				};
				console.log("t1 isValidated query:", queryParams);

				const response = await axios.get(`/t1`, { params: queryParams });
				const dat = response.data as {
					proof: string | undefined;
					status: string;
					debug?: any;
				};
				console.log("t1 isValidated response:", dat);
				return dat.status === "complete" && !!dat.proof;
			} catch (err) {
				console.error("t1 isValidated error:", err);
				return false;
			}
		}

		// Polymer oracle - use isProven function
		const outputClient = getClient(output.chainId);
		const transactionReceipt = await outputClient.getTransactionReceipt({
			hash: fillTransactionHash
		});
		const blockHashOfFill = transactionReceipt.blockHash;
		const block = await outputClient.getBlock({
			blockHash: blockHashOfFill
		});
		const encodedOutput = encodeMandateOutput(
			addressToBytes32(transactionReceipt.from),
			orderId,
			Number(block.timestamp),
			output
		);
		const outputHash = keccak256(encodedOutput);
		const sourceChainClient = getClient(order.originChainId);
		return await sourceChainClient.readContract({
			address: order.inputOracle,
			abi: POLYMER_ORACLE_ABI,
			functionName: "isProven",
			args: [output.chainId, output.oracle, output.settler, outputHash]
		});
	}
</script>

<div class="h-[29rem] w-[25rem] flex-shrink-0 snap-center snap-always p-4">
	<h1 class="w-full text-center text-2xl font-medium">Submit Proof of Fill</h1>
	<p class="my-2">
		Click on each output and wait until they turn green. Polymer does not support batch validation.
		Continue to the right.
	</p>
	<div class="w-full">
		<h2 class="w-full text-center text-lg font-medium">
			{getChainName(orderContainer.order.originChainId)}
		</h2>
		<hr class="my-1" />
		<div class="flex w-full flex-row space-x-1 overflow-y-hidden">
			{#each orderContainer.order.outputs as output}
				{#await isValidated(getOrderId(orderContainer), orderContainer, output, fillTransactionHash, refreshValidation)}
					<div class="h-8 w-28 cursor-pointer rounded bg-slate-100 text-center">
						<div class="flex flex-col items-center justify-center align-middle">
							<div class="flex flex-row space-x-1">
								<div>
									{formatTokenAmount(
										output.amount,
										getCoin({ address: output.token, chain: getChainName(output.chainId) })
									)}
								</div>
								<div>
									{getCoin({ address: output.token, chain: getChainName(output.chainId) }).name}
								</div>
							</div>
						</div>
					</div>
				{:then validated}
					<AwaitButton
						baseClass={["h-8 w-28 rounded text-center", validated ? "bg-green-50" : "bg-yellow-50"]}
						hoverClass={[validated ? "" : "hover:bg-yellow-100 cursor-pointer"]}
						buttonFunction={validated
							? async () => console.log("Has already been validated")
							: Solver.validate(
									walletClient,
									{
										orderContainer,
										fillTransactionHash,
										mainnet
									},
									{
										preHook,
										postHook: postHookRefreshValidate,
										account
									}
								)}
					>
						{#snippet name()}
							<div class="flex flex-row items-center justify-center space-x-1 text-center">
								<div>
									{formatTokenAmount(
										output.amount,
										getCoin({ address: output.token, chain: getChainName(output.chainId) })
									)}
								</div>
								<div>
									{getCoin({ address: output.token, chain: getChainName(output.chainId) }).name}
								</div>
							</div>
						{/snippet}
						{#snippet awaiting()}
							<div class="flex flex-row items-center justify-center space-x-1 text-center">
								<div>
									{formatTokenAmount(
										output.amount,
										getCoin({ address: output.token, chain: getChainName(output.chainId) })
									)}
								</div>
								<div>
									{getCoin({ address: output.token, chain: getChainName(output.chainId) }).name}
								</div>
							</div>
						{/snippet}
					</AwaitButton>
				{/await}
			{/each}
		</div>
	</div>
</div>
