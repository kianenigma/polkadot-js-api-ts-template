import { ApiPromise, WsProvider } from "@polkadot/api";
import yargs from 'yargs';
import { hideBin } from "yargs/helpers"

const options = yargs(hideBin(process.argv))
	.option('endpoint', {
		alias: 'e',
		type: 'string',
		description: 'the wss endpoint. It must allow unsafe RPCs.',
		required: true,
	})
	.argv

async function main() {
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });
	console.log(`Connected to node: ${(await api.rpc.system.chain()).toHuman()} [ss58: ${api.registry.chainSS58}]`)
}

main().catch(console.error).finally(() => process.exit());

