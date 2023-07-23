// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { Balance } from '@polkadot/types/interfaces/runtime';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { BN } from '@polkadot/util';

import { ScProvider } from '@polkadot/rpc-provider/substrate-connect';
import * as Sc from '@substrate/connect';

const optionsPromise = yargs(hideBin(process.argv)).option('endpoint', {
	alias: 'e',
	type: 'string',
	default: 'wss://rpc.polkadot.io',
	description: 'the wss endpoint. It must allow unsafe RPCs.',
	required: true
}).argv;

async function main() {
	const options = await optionsPromise;
	const provider = new WsProvider(options.endpoint);
	const api = await ApiPromise.create({ provider });

	console.log(
		`Connected to node: ${options.endpoint} ${(await api.rpc.system.chain()).toHuman()} [ss58: ${
			api.registry.chainSS58
		}]`
	);

	const lightProvider = new ScProvider(Sc, Sc.WellKnownChain.polkadot);
	await lightProvider.connect();
	const hash = await lightProvider.send('chain_getBlockHash', []);
	console.log('hash from light client:', hash);

	// reading the list of pallets and their version.
	for (const key in api.query) {
		if (api.query[key] && api.query[key].palletVersion) {
			console.log(key, (await api.query[key].palletVersion()).toHuman());
		}
	}

	// reading a constant
	const ED: Balance = api.consts.balances.existentialDeposit;
	console.log(ED.toHuman());

	// subscribe to finalized blocks:
	const unsub = await api.rpc.chain.subscribeFinalizedHeads((header) => {
		console.log(`finalized block #${header.number}`);
	});
}

main().catch(console.error);
