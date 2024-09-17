/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { MangroveEventPool } from './mangrove-pool';
import { Network } from '../../constants';
import { Address } from '../../types';
import { DummyDexHelper } from '../../dex-helper/index';
import { testEventSubscriber } from '../../../tests/utils-events';
import { PoolState } from './types';
import { MangroveConfig } from './config';
import { Tick } from '../uniswap-v3/contract-math/Tick';
import { Tokens } from '../../../tests/constants-e2e';

/*
  README
  ======

  This test script adds unit tests for Mangrove event based
  system. This is done by fetching the state on-chain before the
  event block, manually pushing the block logs to the event-subscriber,
  comparing the local state with on-chain state.

  Most of the logic for testing is abstracted by `testEventSubscriber`.
  You need to do two things to make the tests work:

  1. Fetch the block numbers where certain events were released. You
  can modify the `./scripts/fetch-event-blocknumber.ts` to get the
  block numbers for different events. Make sure to get sufficient
  number of blockNumbers to cover all possible cases for the event
  mutations.

  2. Complete the implementation for fetchPoolState function. The
  function should fetch the on-chain state of the event subscriber
  using just the blocknumber.

  The template tests only include the test for a single event
  subscriber. There can be cases where multiple event subscribers
  exist for a single DEX. In such cases additional tests should be
  added.

  You can run this individual test script by running:
  `npx jest src/dex/<dex-name>/<dex-name>-events.test.ts`

  (This comment should be removed from the final implementation)
*/

jest.setTimeout(50 * 1000);

const dexKey = 'Mangrove';
const network = Network.ARBITRUM;
const config = MangroveConfig[dexKey][network];

async function fetchPoolState(
  mangrovePools: MangroveEventPool,
  blockNumber: number,
  poolAddress: string,
): Promise<PoolState> {
  const message = `Mangrove: ${poolAddress} blockNumber ${blockNumber}`;
  console.log(`Fetching state ${message}`);
  const state = mangrovePools.generateState(blockNumber);
  console.log(`Done ${message}`);
  return state;
}

// eventName -> blockNumbers
type EventMappings = Record<string, number[]>;

describe('Mangrove Event', function () {
  const networkTokens = Tokens[network];
  const srcTokenSymbol = 'USDT'; // WETH
  const destTokenSymbol = 'WETH'; // USDT
  const poolAddress = '';
  const token0 = networkTokens[srcTokenSymbol];
  const token1 = networkTokens[destTokenSymbol];
  const tickSpacing = 1n;

  const blockNumbers: { [eventName: string]: number[] } = {
    // topic0 - 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67
    // ['OrderStart']: [
    //   249762602,
    // ],
    // topic0 - 0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c
    // ['OrderComplete']: [
    //   249762602,
    // ],
    // // topic0 - 0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde
    ['OfferWrite']: [250004786],
    // ['OfferRetract']: [
    //   249762602,
    // ],
    // ['OfferSuccess']: [
    //   249762602,
    // ],
    // ['OfferFail']: [
    //   249762602,
    // ],
    // ['OfferSuccessWithPostHookData']: [
    //   249762602,
    // ],
    // ['OfferFailWithPostHookData']: [
    //   249762602,
    // ],
  };

  describe('Mangrove EventPool', function () {
    Object.keys(blockNumbers).forEach((event: string) => {
      blockNumbers[event].forEach((blockNumber: number) => {
        it(`${event}:${blockNumber} - should return correct state`, async function () {
          const dexHelper = new DummyDexHelper(network);
          const logger = dexHelper.getLogger(dexKey);
          const mangrovePool = new MangroveEventPool(
            dexKey,
            dexHelper,
            config.factory,
            config.reader,
            token0.address,
            token1.address,
            tickSpacing,
            logger,
          );
          blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
          blockNumber = 250004787;

          let state_before = await mangrovePool.generateState(blockNumber - 1);
          console.log('State Before:');
          console.log(state_before);
          let state_after = await mangrovePool.generateState(blockNumber);
          console.log('State on block:');
          console.log(state_after);
          let state_after_after = await mangrovePool.generateState(
            blockNumber + 1,
          );
          console.log('State on block + 1:');
          console.log(state_after_after);

          await testEventSubscriber(
            mangrovePool,
            [config.factory, config.reader], // just an address, not really important I think?
            (_blockNumber: number) =>
              fetchPoolState(mangrovePool, _blockNumber, poolAddress),
            blockNumber,
            `${dexKey}_${poolAddress}`,
            dexHelper.provider,
          );
        });
      });
    });
  });
});
