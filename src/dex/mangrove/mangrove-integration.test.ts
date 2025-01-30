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
import { OLKey } from './types';

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

function getReaderCalldata(
  exchangeAddress: string,
  readerIface: Interface,
  amounts: bigint[],
  olKey: OLKey,
) {
  return amounts.map(amount => ({
    target: exchangeAddress,
    callData: readerIface.encodeFunctionData("simulateMarketOrderByTick", [
      [olKey.outboundtoken, olKey.inboundtoken, olKey.tickSpacing],
      Mangrove.MAX_TICK,
      amount,
      false,
    ]),
  }));
}

function decodeReaderResult(
  results: Result,
  readerIface: Interface,
) {
  // TODO: Adapt this function for your needs
  return results.map(result => {
    const parsed = readerIface.decodeFunctionResult("simulateMarketOrderByTick", result);
    return BigInt(parsed.at(0)?.at(-1)?.totalGot?._hex || 0);
  });
}

async function checkOnChainPricing(
  mangrove: Mangrove,
  blockNumber: number,
  prices: bigint[],
  amounts: bigint[],
  olKeys: OLKey[],
) {
  const exchangeAddress = mangrove.readerAddress;

  // TODO: Replace dummy interface with the real one
  // Normally you can get it from mangrove.Iface or from eventPool.
  // It depends on your implementation
  const readerIface = Mangrove.mgvReaderIface;

  const readerCallData = getReaderCalldata(
    exchangeAddress,
    readerIface,
    amounts.slice(1),
    olKeys[0],
  );
  const readerResult = (
    await mangrove.dexHelper.multiContract.methods
      .aggregate(readerCallData)
      .call({}, blockNumber)
  ).returnData;

  const expectedPrices = [0n].concat(
    decodeReaderResult(readerResult, readerIface),
  );

  expect(prices).toEqual(expectedPrices);
}

async function testPricingOnNetwork(
  mangrove: Mangrove,
  network: Network,
  dexKey: string,
  blockNumber: number,
  srcTokenSymbol: string,
  destTokenSymbol: string,
  side: SwapSide,
  amounts: bigint[],
  funcNameToCheck: string,
) {
  const networkTokens = Tokens[network];

  const pools = await mangrove.getPoolIdentifiers(
    networkTokens[srcTokenSymbol],
    networkTokens[destTokenSymbol],
    side,
    blockNumber,
  );
  console.log(
    `${srcTokenSymbol} <> ${destTokenSymbol} Pool Identifiers: `,
    pools,
  );

  expect(pools.length).toBeGreaterThan(0);

  const poolPrices = await mangrove.getPricesVolume(
    networkTokens[srcTokenSymbol],
    networkTokens[destTokenSymbol],
    amounts,
    side,
    blockNumber,
    pools,
  );
  console.log(
    `${srcTokenSymbol} <> ${destTokenSymbol} Pool Prices: `,
    poolPrices,
  );


  if (side === SwapSide.SELL) {
    expect(poolPrices).not.toBeNull();
  } else {
    expect(poolPrices).toBeNull();
    return;
  }

  if (mangrove.hasConstantPriceLargeAmounts) {
    checkConstantPoolPrices(poolPrices!, amounts, dexKey);
  } else {
    checkPoolPrices(poolPrices!, amounts, side, dexKey);
  }

  // Check if onchain pricing equals to calculated ones
  await checkOnChainPricing(
    mangrove,
    blockNumber,
    poolPrices![0].prices,
    amounts,
    pools.map(pool => Mangrove.toOlKey(pool)),
  );
}

describe('Mangrove', function () {
  const dexKey = 'Mangrove';
  let blockNumber: number;
  let mangrove: Mangrove;

  describe('Arbitrum', () => {
    const network = Network.ARBITRUM;
    const dexHelper = new DummyDexHelper(network);

    const tokens = Tokens[network];

    // TODO: Put here token Symbol to check against
    // Don't forget to update relevant tokens in constant-e2e.ts
    const srcTokenSymbol = 'USDC';
    const destTokenSymbol = 'WETH';

    const amountsForSell = [
      0n,
      1n * BI_POWS[tokens[srcTokenSymbol].decimals],
      2n * BI_POWS[tokens[srcTokenSymbol].decimals],
      3n * BI_POWS[tokens[srcTokenSymbol].decimals],
      4n * BI_POWS[tokens[srcTokenSymbol].decimals],
      5n * BI_POWS[tokens[srcTokenSymbol].decimals],
      6n * BI_POWS[tokens[srcTokenSymbol].decimals],
      7n * BI_POWS[tokens[srcTokenSymbol].decimals],
      8n * BI_POWS[tokens[srcTokenSymbol].decimals],
      9n * BI_POWS[tokens[srcTokenSymbol].decimals],
      10n * BI_POWS[tokens[srcTokenSymbol].decimals],
    ];

    const amountsForBuy = [
      0n,
      1n * BI_POWS[tokens[destTokenSymbol].decimals],
      2n * BI_POWS[tokens[destTokenSymbol].decimals],
      3n * BI_POWS[tokens[destTokenSymbol].decimals],
      4n * BI_POWS[tokens[destTokenSymbol].decimals],
      5n * BI_POWS[tokens[destTokenSymbol].decimals],
      6n * BI_POWS[tokens[destTokenSymbol].decimals],
      7n * BI_POWS[tokens[destTokenSymbol].decimals],
      8n * BI_POWS[tokens[destTokenSymbol].decimals],
      9n * BI_POWS[tokens[destTokenSymbol].decimals],
      10n * BI_POWS[tokens[destTokenSymbol].decimals],
    ];



    beforeAll(async () => {
      blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
      console.log("blockNumber", blockNumber);
      mangrove = new Mangrove(network, dexKey, dexHelper);
      const openMarkets = await mangrove.getOpenMarkets();
      // console.log('Open Markets:', openMarkets);
    });

    it('getPoolIdentifiers and getPricesVolume SELL', async function () {
      await testPricingOnNetwork(
        mangrove,
        network,
        dexKey,
        blockNumber,
        srcTokenSymbol,
        destTokenSymbol,
        SwapSide.SELL,
        amountsForSell,
        'simulateMarketOrderByTick',
      );
    });

    it('getPoolIdentifiers and getPricesVolume BUY', async function () {
      await testPricingOnNetwork(
        mangrove,
        network,
        dexKey,
        blockNumber,
        srcTokenSymbol,
        destTokenSymbol,
        SwapSide.BUY,
        amountsForBuy,
        'simulateMarketOrderByTick',
      );
    });
  });
});
