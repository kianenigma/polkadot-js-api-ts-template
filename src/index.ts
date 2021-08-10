import { ApiPromise, WsProvider } from "@polkadot/api";
// import { BN } from "@polkadot/util/bn/bn";
import yargs from 'yargs';
import { hideBin } from "yargs/helpers"

const optionsPromise = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		description: 'the wss endpoint. It must allow unsafe RPCs.',
		required: true,
	})
	.argv

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	console.log(`Connected to node: ${options.endpoint} ${(await api.rpc.system.chain()).toHuman()} [ss58: ${api.registry.chainSS58}]`)
}

main().catch(console.error).finally(() => process.exit());

