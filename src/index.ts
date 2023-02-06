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
			const ratioPercent = poolPoints.mul(new BN(100)).div(BN.max(poolActiveBalance, new BN(1)));
			const unbondingBalance = ledger.total.toBn().sub(ledger.active.toBn());
			const poolInfo = {
				// state of the pool: open, blocked.
				state: bondedPool.unwrapOrDefault().state,
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

	// NOTE: each metric is prefix with the pallet from which it is coming from.

	function sum(t: BN[]): BN {
		if (t.length == 0) {
			return new BN(0);
		}
		return t.reduce((p, c) => p.add(c));
	}

	// 1. General staking metrics
	const currentEra = (await api.query.staking.currentEra()).unwrap();
	const [ledgersEntries, exposures] = await Promise.all([
		api.query.staking.ledger.entries(),
		api.query.staking.erasStakers.entries(currentEra)
	]);
	const ledgers = ledgersEntries.map(([_, l]) => l.unwrap());
	const ledgersMap = new Map(
		ledgersEntries.map(([w, l]) => [l.unwrap().stash.toString(), l.unwrap()])
	);

	// Count of all nominators.
	console.log(`staking_nominatorCount: ${await api.query.staking.counterForNominators()}`);
	// Count of all validators
	console.log(`staking_validatorCount: ${await api.query.staking.counterForValidators()}`);
	// Count of all accounts staked. These accounts have not declared intention to validate and/or nomiante.
	console.log(`staking_stakedAccountCount: ${ledgers.length}`);

	const stakingStaked = await api.query.staking.erasTotalStake(currentEra);
	// Number of tokens staked.
	console.log(`staking_staked ${b(stakingStaked)}`);

	// TODO: will come into motion once goes into production: https://github.com/paritytech/substrate/pull/12889/files
	// Minimum active/rewardable stake for nominators.
	const minNominatorsActiveStake = api.query.staking.minimumActiveStake
		? (await api.query.staking.minimumActiveStake()).toBn()
		: new BN(0);
	console.log(`staking_minNominatorsActiveStake: ${minNominatorsActiveStake}`);

	// the following two indicates how much stake is being unbonded.

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

	// then, we look into the when they are free to be unbonded;

	const allUnlocking = ledgers.flatMap((l) => Array.from(l.unlocking));
	let alreadyUnlocked = new BN(0);
	const unlockingAtEra: Map<number, BN> = new Map();
	allUnlocking.forEach((u) => {
		if (u.era.toNumber() <= currentEra.toNumber()) {
			alreadyUnlocked = alreadyUnlocked.add(u.value.toBn());
		} else if (unlockingAtEra.has(u.era.toNumber())) {
			const current = unlockingAtEra.get(u.era.toNumber())!;
			unlockingAtEra.set(u.era.toNumber(), current.add(u.value.toBn()));
		} else {
			unlockingAtEra.set(u.era.toNumber(), u.value.toBn());
		}
	});

	// Amount of unbonding stake that is already unlocked.
	console.log(`staking_unbondingAlreadyUnlocked ${b(alreadyUnlocked)}`);
	Array.from(unlockingAtEra)
		.sort((x, y) => x[0] - y[0])
		.forEach(([era, amount]) => {
			// Amount of unbonding stake being free to unbond at any of the given eras. only contains future eras.
			console.log(`staking_unbondingUnlockingAtEra_${era}: ${b(amount)}`);
		});

	// -------------------------------------------------
	// 2. Metrics related to inactive nominators, one of the main goals:

	const allOthers = new Set(exposures.flatMap(([_, e]) => e.others.map((i) => i.who.toString())));
	const nominators = (await api.query.staking.nominators.entries()).map(([n, _]) => n.args[0]);
	const inactiveNominators = nominators.filter((n) => !allOthers.has(n.toString()));

	// number of inactive nominators
	console.log(`inactiveNominators_count: ${inactiveNominators.length}`);
	// number of inactive nominators who are fully unbonding
	console.log(
		`inactiveNominators_fullyUnbondingCount: ${
			inactiveNominators.filter((n) => {
				const l = ledgersMap.get(n.toString());
				return l?.active.toBn().isZero();
			}).length
		}`
	);
	// number of inactive nominators who are fully or partially unbonding.
	console.log(
		`inactiveNominators_unbondingCount: ${
			inactiveNominators.filter((n) => {
				const l = ledgersMap.get(n.toString());
				return l?.unlocking.length != 0;
			}).length
		}`
	);
	// total tokens that are bonded by inactive nominators
	console.log(
		`inactiveNominators_bonded ${b(
			sum(
				inactiveNominators.map((n) => {
					const l = ledgersMap.get(n.toString());
					return l?.active.toBn() || new BN(0);
				})
			)
		)}`
	);
	// total tokens that are unbonding by inactive nominators.
	console.log(
		`inactiveNominators_unbonding ${b(
			sum(
				inactiveNominators.map((n) => {
					const l = ledgersMap.get(n.toString());
					return l?.total.toBn().sub(l.active.toBn()) || new BN(0);
				})
			)
		)}`
	);

	// -------------------------------------------------
	// 3. Metrics related to pools:

	// Count of all pools.
	console.log(`pools_poolsCount: ${poolsCount}`);
	// Count of open pools.
	console.log(`pools_openPoolCount: ${PoolsDetails.filter((p) => p.state.isOpen).length}`);
	// Count of blocked pools.
	console.log(`pools_blockedPoolCount: ${PoolsDetails.filter((p) => p.state.isBlocked).length}`);
	// Count of destroying pools.
	console.log(
		`pools_destroyingPoolCount: ${PoolsDetails.filter((p) => p.state.isDestroying).length}`
	);
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

	const poolPointToBalance = (amount: BN, pool: { poolPoints: BN; poolActiveBalance: BN }) =>
		amount.mul(pool.poolActiveBalance).div(BN.max(pool.poolPoints, new BN(1)));

	// Number of members having less than 200 DOTs in the pool, per pool. Mapping from poolId to count.
	const minimumActiveStake = minNominatorsActiveStake;
	const membersLessThanLimit = (await api.query.nominationPools.poolMembers.entries())
		.map(([_, m]) => {
			const member = m.unwrap();
			const pool = PoolsDetails.find((p) => p.poolId.eq(member.poolId));
			return poolPointToBalance(member.points, pool!);
		})
		.filter((p) => p.lt(minimumActiveStake)).length;
	console.log(`pools_membersLessThan${b(minimumActiveStake)}: ${membersLessThanLimit}`);

	const poolsStake = sum(PoolsDetails.map((p) => p.poolActiveBalance));
	// The number of tokens staked via pools.
	console.log(`pools_staked: ${b(poolsStake)}`);
	// Same as above, but in points.
	console.log(`pools_points: ${b(sum(PoolsDetails.map((p) => p.poolPoints)))}`);

	// Ratio of dots staked via pools. This is `pools_sum_staked / staking_sumStaked`. Can be calculated in the frontend.
	console.log(
		// this will allow us to detect a ratio as small as one-millionth.
		`pools_stakingRatio ${(
			poolsStake.mul(new BN(1000000)).div(stakingStaked).toNumber() / 1000000
		).toFixed(4)}`
	);

	// Total balance being unbonded from all pools.
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
