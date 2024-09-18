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
import MangroveReaderABI from '../../abi/mangrove/MangroveReader.abi.json';
import { Token } from '../../types';
import { mktOrderDecoder } from './mangrove';
import { ExchangePrices } from '../../types';
import { MangroveData } from './types';
/*
  README
  ======

  This test script adds tests for Mangrove general integration
  with the DEX interface. The test cases below are example tests.
  It is recommended to add tests which cover Mangrove specific
  logic.

  You can run this individual test script by running:
  `npx jest src/dex/mangrove/mangrove-integration.test.ts`

  (This comment should be removed from the final implementation)
*/

const network = Network.ARBITRUM;
const srcTokenSymbol = 'USDT';
const srcToken = Tokens[network][srcTokenSymbol];

const destTokenSymbol = 'WETH';
const destToken = Tokens[network][destTokenSymbol];

const tickSpacing = 1n;

const amounts = [
  0n,
  1_000n * BI_POWS[6],
  20_000n * BI_POWS[6],
  30_000n * BI_POWS[6],
];

const simulFnName =
  'simulateMarketOrderByTick((address, address, uint256), int256, uint256, bool)';

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
  olkey: (string | bigint)[] | undefined,
  maxTick: number = 887272,
  fillWants: boolean = false,
  // TODO: Put here additional arguments you need
) {
  return amounts.map(amount => ({
    target: exchangeAddress,
    gasLimit: 20000000, // TO DO
    callData: readerIface.encodeFunctionData(
      'simulateMarketOrderByTick((address, address, uint256), int256, uint256, bool)',
      [olkey, maxTick, amount, fillWants],
    ),
    decodeFunction: mktOrderDecoder,
  }));
}

async function checkOnChainPricing(
  mangrove: Mangrove,
  funcName: string,
  blockNumber: number,
  prices: bigint[],
  amounts: bigint[],
  srcToken: Token,
  destToken: Token,
) {
  const exchangeAddress = '0x7E108d7C9CADb03E026075Bf242aC2353d0D1875'; // TODO: Put here the real exchange address

  // TODO: Replace dummy interface with the real one
  // Normally you can get it from mangrove.Iface or from eventPool.
  // It depends on your implementation
  const readerIface = new Interface(MangroveReaderABI);

  const pool = await mangrove.getPool(
    srcToken.address,
    destToken.address,
    tickSpacing,
  );

  const rpcResult = await mangrove.getPricingFromRpc(
    srcToken,
    destToken,
    amounts,
  );
  const expectedPrices = rpcResult?.[0]?.prices;
  console.log('rpcResult: ', rpcResult);

  const roundedExpectedPrices = expectedPrices?.map(p =>
    Number((Number(p) / Number(10n ** 18n)).toFixed(6)),
  );
  const roundedPoolPrices = prices?.map(p =>
    Number((Number(p) / Number(10n ** 18n)).toFixed(6)),
  );
  console.log('expectedPrices: ', roundedExpectedPrices);
  console.log('poolPrices: ', roundedPoolPrices);
  expect(roundedPoolPrices).toEqual(roundedExpectedPrices);
  // const expectedPrices = [0n].concat(
  //   decodeReaderResult(readerResult, readerIface, funcName),
  // );

  // expect(prices).toEqual(expectedPrices);
  return true;
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
    it('Compare RPC price vs Event based price', async function () {
      const pool = await mangrove.getPool(
        srcToken.address,
        destToken.address,
        tickSpacing,
      );

      const poolPrices = await mangrove.getPricesVolume(
        srcToken,
        destToken,
        amounts,
        SwapSide.SELL,
        blockNumber,
      );
      console.log('poolPrices: ', poolPrices);

      await Promise.all(
        poolPrices!.map(async price => {
          const res = await checkOnChainPricing(
            mangrove,
            simulFnName,
            blockNumber,
            price.prices,
            amounts,
            srcToken,
            destToken,
          );
        }),
      );
    });
  });
});
