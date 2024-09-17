/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { Interface, Result } from '@ethersproject/abi';
import { DummyDexHelper } from '../../dex-helper/index';
import { Network, SwapSide } from '../../constants';
import { BI_POWS } from '../../bigint-constants';
import { Mangrove } from './mangrove';
import {
  checkPoolPrices,
  checkPoolsLiquidity,
  checkConstantPoolPrices,
} from '../../../tests/utils';
import { Tokens } from '../../../tests/constants-e2e';
import { MangroveEventPool } from './mangrove-pool';
import { MangroveConfig } from './config';
import { escape } from 'lodash';
import { assert } from 'console';
import { read } from 'fs';

/*
  README
  ======

  This test script adds tests for Mangrove general integration
  with the DEX interface. The test cases below are example tests.
  It is recommended to add tests which cover Mangrove specific
  logic.

  You can run this individual test script by running:
  `npx jest src/dex/<dex-name>/<dex-name>-integration.test.ts`

  (This comment should be removed from the final implementation)
*/

const network = Network.ARBITRUM;
const srcTokenSymbol = 'USDT';
const srcToken = Tokens[network][srcTokenSymbol];

const destTokenSymbol = 'WETH';
const destToken = Tokens[network][destTokenSymbol];

const tickSpacing = 1n;

console.log('----------------:');
console.log('TEST PARAMETERS:');
console.log(`Network : ${network}`);
console.log(`srcTokenSymbol : ${srcTokenSymbol}`);
console.log(`srcTokenDecimals : ${srcToken.decimals}`);
console.log(`destTokenSymbol : ${destTokenSymbol}`);
console.log(`destTokenDecimals : ${destToken.decimals}`);
console.log('----------------:');

function getReaderCalldata(
  exchangeAddress: string,
  readerIface: Interface,
  amounts: bigint[],
  funcName: string,
  // TODO: Put here additional arguments you need
) {
  return amounts.map(amount => ({
    target: exchangeAddress,
    callData: readerIface.encodeFunctionData(funcName, [
      // TODO: Put here additional arguments to encode them
      amount,
    ]),
  }));
}

function decodeReaderResult(
  results: Result,
  readerIface: Interface,
  funcName: string,
) {
  // TODO: Adapt this function for your needs
  return results.map(result => {
    const parsed = readerIface.decodeFunctionResult(funcName, result);
    return BigInt(parsed[0]._hex);
  });
}

async function checkOnChainPricing(
  mangrove: Mangrove,
  funcName: string,
  blockNumber: number,
  prices: bigint[],
  amounts: bigint[],
) {
  const exchangeAddress = ''; // TODO: Put here the real exchange address

  // TODO: Replace dummy interface with the real one
  // Normally you can get it from mangrove.Iface or from eventPool.
  // It depends on your implementation
  const readerIface = new Interface('');

  const readerCallData = getReaderCalldata(
    exchangeAddress,
    readerIface,
    amounts.slice(1),
    funcName,
  );
  const readerResult = (
    await mangrove.dexHelper.multiContract.methods
      .aggregate(readerCallData)
      .call({}, blockNumber)
  ).returnData;

  const expectedPrices = [0n].concat(
    decodeReaderResult(readerResult, readerIface, funcName),
  );

  expect(prices).toEqual(expectedPrices);
}

describe('Mangrove', function () {
  const dexHelper = new DummyDexHelper(network);
  const dexKey = 'Mangrove';
  let blockNumber: number;
  let mangrove: Mangrove;

  beforeEach(async () => {
    blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
    mangrove = new Mangrove(network, dexKey, dexHelper);
  });

  describe('Arbitrum', () => {
    it('getMktPrice : given a state does it price what its supposed to', async function () {
      const testAmounts = [
        1_000n * BI_POWS[srcToken.decimals],
        5_000n * BI_POWS[srcToken.decimals],
        10_000n * BI_POWS[srcToken.decimals],
        100_000n * BI_POWS[srcToken.decimals],
      ];

      let poolState = {
        blockNumber: 0,
        nextOffer: 0n,
        offersIds: [1n, 2n, 3n, 4n, 5n],
        offers: [
          { prev: 0n, next: 0n, tick: -198785n, gives: 2899102924800000000n },
          { prev: 0n, next: 0n, tick: -198783n, gives: 2899102924800000000n },
          { prev: 0n, next: 0n, tick: -198781n, gives: 2899102924800000000n },
          { prev: 0n, next: 0n, tick: -198780n, gives: 2899102924800000000n },
          { prev: 0n, next: 0n, tick: -198778n, gives: 2899102924800000000n },
        ],
        offersDetail: [
          {
            maker: '0x57d26b65fb1978A18754D4e417c13B207A687C13',
            gasreq: 2000000n,
            kilo_offer_gasbase: 250n,
            gasprice: 20n,
          },
          {
            maker: '0x57d26b65fb1978A18754D4e417c13B207A687C13',
            gasreq: 2000000n,
            kilo_offer_gasbase: 250n,
            gasprice: 20n,
          },
          {
            maker: '0x57d26b65fb1978A18754D4e417c13B207A687C13',
            gasreq: 2000000n,
            kilo_offer_gasbase: 250n,
            gasprice: 20n,
          },
          {
            maker: '0x57d26b65fb1978A18754D4e417c13B207A687C13',
            gasreq: 2000000n,
            kilo_offer_gasbase: 250n,
            gasprice: 20n,
          },
          {
            maker: '0x57d26b65fb1978A18754D4e417c13B207A687C13',
            gasreq: 2000000n,
            kilo_offer_gasbase: 250n,
            gasprice: 20n,
          },
        ],
      };

      let res = testAmounts.map(amount =>
        mangrove.getMktPrice(poolState, amount),
      );

      // Use sheet https://docs.google.com/spreadsheets/d/1KNON2hGNcRHfCztp5ickhJJU_0-nrRttfGp5AXy_P9g
      assert(
        res[0] == BigInt(429_231_149_261_737_000),
        'Wrong price for first amount',
      );
      assert(
        res[1] == BigInt(2_146_155_746_308_680_000),
        'Wrong price for first amount',
      );
      assert(
        res[2] == BigInt(4_292_032_892_694_490_000),
        'Wrong price for first amount',
      );
      assert(res[3] == BigInt(-1), 'Wrong price for first amount');
    });

    it('getPoolState and getPricesVolume', async function () {
      const pool = await mangrove.getPool(
        srcToken.address,
        destToken.address,
        tickSpacing,
      );
      console.log(`Pool State at blockNumber ${blockNumber}: `);
      console.log(pool?.getState(blockNumber));

      const amounts = [
        0n,
        1_000n * BI_POWS[srcToken.decimals],
        5_000n * BI_POWS[srcToken.decimals],
        10_000n * BI_POWS[srcToken.decimals],
        100_000n * BI_POWS[srcToken.decimals],
      ];

      const poolPricesBuy = await mangrove.getPricesVolume(
        srcToken,
        destToken,
        amounts,
        SwapSide.BUY, // side is not needed
        blockNumber,
      );

      const poolPricesSell = await mangrove.getPricesVolume(
        srcToken,
        destToken,
        amounts,
        SwapSide.SELL, // side is not needed
        blockNumber,
      );

      assert(
        poolPricesBuy?.at(0)?.prices[0] == poolPricesSell?.at(0)?.prices[0],
        'Buy and Sell side are different',
      );
      assert(
        poolPricesBuy?.at(0)?.prices[1] == poolPricesSell?.at(0)?.prices[1],
        'Buy and Sell side are different',
      );
      assert(
        poolPricesBuy?.at(0)?.prices[2] == poolPricesSell?.at(0)?.prices[2],
        'Buy and Sell side are different',
      );

      console.log(`Pricing at ${blockNumber}: `);
      console.log(
        `${srcTokenSymbol} <> ${destTokenSymbol} Pool Prices: `,
        poolPricesBuy,
      );
    });

    it('Compare RPC price vs Event based price', async function () {
      const amountToCompare = 10_000n * BI_POWS[srcToken.decimals];

      const eventPrice = await mangrove.getPricesVolume(
        srcToken,
        destToken,
        [amountToCompare],
        SwapSide.BUY, // side is not needed
        blockNumber,
      );

      console.log('eventPrice :');
      console.log(eventPrice);

      const rpcPrice = await mangrove.getPricingFromRpc(srcToken, destToken, [
        amountToCompare,
      ]);

      console.log('rpcPrice :');
      console.log(rpcPrice);
    });
  });
});
