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
			const poolPoints = bondedPool.unwrapOrDefault().points.toBn();
			const palletId = api.consts.nominationPools.palletId.toU8a();
			const rewardAccount = createAccount(api, palletId, poolId, 1);
			const bondedAccount = createAccount(api, palletId, poolId, 0);
			const existentialDeposit = api.consts.balances.existentialDeposit;
			const pendingRewards = (await api.query.system.account(rewardAccount)).data.free.sub(
				existentialDeposit
			);
			const ledger = (await api.query.staking.ledger(bondedAccount)).unwrap();
			const poolActiveBalance = ledger.active.toBn();
			const ratioPercent = poolPoints.mul(new BN(100)).div(poolActiveBalance);
			const unbondingBalance = ledger.total.toBn().sub(ledger.active.toBn());
			const poolInfo = {
				// id of the pool.
				poolId,
				// number of members
				members,
				// total points in the pool.
				poolPoints,
				// total balance in the pool.
				poolActiveBalance,
				// ratio of point to balance in this pool, in percent.
				ratioPercent,
				// amount of balance being unbonded form the pool
				unbondingBalance,
				// the total pending rewards of hte pool.
				pendingRewards
			};
			return poolInfo;
		})
	);

	const currentEra = (await api.query.staking.currentEra()).unwrap();

	// NOTE: each metric is prefix with the pallet from which it is coming from.

	function sum(t: BN[]): BN {
		return t.reduce((p, c) => p.add(c));
	}

	// Count of all nominators.
	console.log(`staking_nominatorCount: ${await api.query.staking.counterForNominators()}`);
	console.log(
		`staking_inactiveNominatorCount: ${(await api.query.staking.counterForNominators()).sub(
			api.consts.electionProviderMultiPhase.maxElectingVoters
		)}`
	);
	// Count of all validators
	console.log(`staking_validatorCount: ${await api.query.staking.counterForValidators()}`);
	// Number of DOTs staked in general.
	const stakingStaked = await api.query.staking.erasTotalStake(currentEra);
	console.log(`staking_staked ${b(stakingStaked)}`);

	// NOTE: next two metrics take a lot of time, if too slow, consider skipping, or scraping less frequent.
	const ledgers = (await api.query.staking.ledger.entries()).map(([_, l]) => l.unwrap());

	// Amount of dots being unstaked from staking. Will give un an indicate of how many people are unbonding.
	console.log(
		`staking_unbondingStake ${b(sum(ledgers.map((l) => l.total.toBn().sub(l.active.toBn()))))}`
	);
	// Number of stakers who have some kind of partial unstake process going on
	console.log(`staking_unbondingCount ${ledgers.filter((l) => !l.total.eq(l.active)).length}`);
	// Number of stakers that are scheduled to fully unbond.
	console.log(
		`staking_fullyUnbondingCount ${
			ledgers.filter((l) => l.active.toBn().isZero() && l.unlocking.length > 0).length
		}`
	);

	// Count of all pools.
	console.log(`pools_poolsCount: ${poolsCount}`);
	// Number of pools which are not slashed and have 1-1 point to balance ratio.
	console.log(
		`pools_unslashedPoolsCount ${PoolsDetails.filter((p) => p.ratioPercent.eq(new BN(100))).length}`
	);

	// Members in all pools.
	console.log(`pools_membersCount: ${membersCount}`);
	// Average member count across pools.
	console.log(
		`pools_avgMemberPerPool: ${(membersCount.toNumber() / poolsCount.toNumber()).toFixed(1)}`
	);
	// NOTE: the following is rather slow, remove if not needed.
	// Number of members having less than 200 DOTs in the pool, per pool. Mapping from poolId to count.
	const pointsLimit = new BN(10).pow(new BN(10)).mul(new BN(200));
	const membersLessThanLimit = (await api.query.nominationPools.poolMembers.entries())
		.map(([_, m]) => m.unwrap().points)
		.filter((p) => p.lt(pointsLimit)).length;
	console.log(`pools_membersLessThan${b(pointsLimit)}: ${membersLessThanLimit}`);

	// The number of DOTs staked via pools.
	const poolsStake = sum(PoolsDetails.map((p) => p.poolActiveBalance));
	console.log(`pools_staked: ${b(poolsStake)}`);
	// Same as above, but in points.
	console.log(`pools_points: ${b(sum(PoolsDetails.map((p) => p.poolPoints)))}`);

	// Ratio of dots staked via pools. This is `pools_sum_staked / staking_sumStaked`.
	console.log(
		// this will allow us to detect a ratio as small as one-millionth.
		`pools_stakingRatio ${(
			poolsStake.mul(new BN(1000000)).div(stakingStaked).toNumber() / 1000000
		).toFixed(4)}`
	);

	// Total balance being unbonded from pools.
	console.log(
		`pools_unbondingBalance: ${b(
			PoolsDetails.map((p) => p.unbondingBalance).reduce((p, c) => p.add(c))
		)}`
	);
	// the amount of pending rewards in all pools over time. We want the integral of this, and we
	// interpret it as: Total DOTs rewarded via poos in a period of time.
	console.log(
		`pools_pendingRewards: ${b(
			PoolsDetails.map((p) => p.pendingRewards).reduce((p, c) => p.add(c))
		)}`
	);
}

main().catch(console.error);
