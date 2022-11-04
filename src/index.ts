// needed as of 7.x series, see CHANGELOG of the api repo.
import '@polkadot/api-augment';
import '@polkadot/types-augment';

import { ApiPromise, WsProvider } from '@polkadot/api';
import { hideBin } from 'yargs/helpers';
import { GenericAccountId } from '@polkadot/types';
import { BN, bnToU8a, stringToU8a, u8aConcat } from '@polkadot/util';
import yargs from 'yargs';

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

	function createAccount(
		api: ApiPromise,
		palletId: Uint8Array,
		poolId: BN,
		index: number
	): GenericAccountId {
		const EMPTY_H256 = new Uint8Array(32);
		const MOD_PREFIX = stringToU8a('modl');
		const U32_OPTS = { bitLength: 32, isLe: true };
		return api.registry.createType(
			'AccountId32',
			u8aConcat(
				MOD_PREFIX,
				palletId,
				new Uint8Array([index]),
				bnToU8a(poolId, U32_OPTS),
				EMPTY_H256
			)
		);
	}

	const b = (x: unknown) => api.createType('Balance', x).toHuman();

	// count of all nomination pools.
	const poolsCount = await api.query.nominationPools.counterForBondedPools();
	// count of all members.
	const membersCount = await api.query.nominationPools.counterForPoolMembers();

	const PoolsDetails = await Promise.all(
		(
			await api.query.nominationPools.bondedPools.entries()
		).map(async ([key, bondedPool]) => {
			const poolId = key.args[0];
			const members = bondedPool.unwrapOrDefault().memberCounter;
			const totalPoints = bondedPool.unwrapOrDefault().points.toBn();
			const palletId = api.consts.nominationPools.palletId.toU8a();
			const rewardAccount = createAccount(api, palletId, poolId, 1);
			const bondedAccount = createAccount(api, palletId, poolId, 0);
			const existentialDeposit = api.consts.balances.existentialDeposit;
			const pendingRewards = (await api.query.system.account(rewardAccount)).data.free.sub(
				existentialDeposit
			);
			const ledger = (await api.query.staking.ledger(bondedAccount)).unwrap();
			const totalBalance = ledger.total.toBn();
			const ratioPercent = totalPoints.mul(new BN(100)).div(totalBalance);
			const unbondingBalance = ledger.total.toBn().sub(ledger.total.toBn());
			return {
				// id of the pool.
				poolId,
				// number of members
				members,
				// total points in the pool.
				totalPoints,
				// total balance in the pool.
				totalBalance,
				// ratio of point to balance in this pool, in percent.
				ratioPercent,
				// amount of balance being unbonded form the pool
				unbondingBalance,
				// the total pending rewards of hte pool.
				pendingRewards
			};
		})
	);

	console.log(`poolsCount: ${poolsCount}`);
	console.log(`membersCount: ${membersCount}`);
	console.log(
		`average members per pool: ${(membersCount.toNumber() / poolsCount.toNumber()).toFixed(1)}`
	);
	console.log(
		`sum(totalPoints): ${b(PoolsDetails.map((p) => p.totalPoints).reduce((p, c) => p.add(c)))}`
	);
	console.log(
		`sum(totalBalance): ${b(PoolsDetails.map((p) => p.totalBalance).reduce((p, c) => p.add(c)))}`
	);
	console.log(
		`sum(unbondingBalance): ${b(
			PoolsDetails.map((p) => p.unbondingBalance).reduce((p, c) => p.add(c))
		)}`
	);
	console.log(
		`sum(pendingRewards): ${b(
			PoolsDetails.map((p) => p.pendingRewards).reduce((p, c) => p.add(c))
		)}`
	);
}

main().catch(console.error);
