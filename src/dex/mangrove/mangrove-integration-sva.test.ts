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

async function testPricingOnNetwork(
  mangrove: Mangrove,
  network: Network,
  dexKey: string,
  blockNumber: number,
  srcTokenSymbol: string,
  destTokenSymbol: string,
  tickSpacing: bigint = 1n,
  amounts: bigint[],
  funcNameToCheck: string,
) {
  const networkTokens = Tokens[network];

  const pool_identifier = await mangrove.getPoolIdentifier(
    networkTokens[srcTokenSymbol].address,
    networkTokens[destTokenSymbol].address,
    tickSpacing,
  );

  const pool = await mangrove.getPool(
    networkTokens[srcTokenSymbol].address,
    networkTokens[destTokenSymbol].address,
    tickSpacing,
    blockNumber,
  );

  await pool?.initialize(blockNumber);
  console.log(
    `${srcTokenSymbol} <> ${destTokenSymbol} Pool Identifiers: `,
    pool,
  );
  let state = await pool?.generateState(blockNumber);
  console.log(state);

  let data = mangrove.getPricingFromRpc(
    networkTokens[srcTokenSymbol],
    networkTokens[destTokenSymbol],
    amounts,
    pool as MangroveEventPool,
  );

  // const poolPrices = await mangrove.getPricesVolume(
  //   networkTokens[srcTokenSymbol],
  //   networkTokens[destTokenSymbol],
  //   amounts,
  //   side,
  //   blockNumber,
  //   pools,
  // );
  // console.log(
  //   `${srcTokenSymbol} <> ${destTokenSymbol} Pool Prices: `,
  //   poolPrices,
  // );

  // expect(poolPrices).not.toBeNull();
  // if (mangrove.hasConstantPriceLargeAmounts) {
  //   checkConstantPoolPrices(poolPrices!, amounts, dexKey);
  // } else {
  //   checkPoolPrices(poolPrices!, amounts, side, dexKey);
  // }

  // // Check if onchain pricing equals to calculated ones
  // await checkOnChainPricing(
  //   mangrove,
  //   funcNameToCheck,
  //   blockNumber,
  //   poolPrices![0].prices,
  //   amounts,
  // );
}

describe('Mangrove', function () {
  const dexKey = 'Mangrove';
  let blockNumber: number;
  let mangrove: Mangrove;

  describe('Arbitrum', () => {
    const network = Network.ARBITRUM;
    const dexHelper = new DummyDexHelper(network);
    const dexKey = 'Mangrove';
    const tickSpacing = 1n;

    let blockNumber: number;
    let mangrove: Mangrove;

    const tokens = Tokens[network];

    // TODO: Put here token Symbol to check against
    // Don't forget to update relevant tokens in constant-e2e.ts
    const srcTokenSymbol = 'USDT'; // WETH
    const destTokenSymbol = 'WETH'; // USDC

    const amountsForSell = [0n, 100000000n, 200000000n];

    const amountsForBuy = [0n, 100000000n, 200000000n];

    beforeAll(async () => {
      blockNumber = await dexHelper.web3Provider.eth.getBlockNumber();
      mangrove = new Mangrove(network, dexKey, dexHelper);

      if (mangrove.initializePricing) {
        await mangrove.initializePricing(blockNumber);
      }
    });

    it('getPoolIdentifiers and getPricesVolume SELL', async function () {
      await testPricingOnNetwork(
        mangrove,
        network,
        dexKey,
        blockNumber,
        srcTokenSymbol,
        destTokenSymbol,
        tickSpacing,
        amountsForSell,
        '', // TODO: Put here proper function name to check pricing
      );
    });
  });
});
