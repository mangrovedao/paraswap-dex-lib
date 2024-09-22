/* eslint-disable no-console */
import dotenv from 'dotenv';
dotenv.config();

import { Interface, Result } from '@ethersproject/abi';
import { DummyDexHelper } from '../../dex-helper/index';
import { Network, SwapSide } from '../../constants';
import { BI_POWS } from '../../bigint-constants';
import { Mangrove } from './mangrove';

import { Tokens } from '../../../tests/constants-e2e';

import MangroveReaderABI from '../../abi/mangrove/MangroveReader.abi.json';
import { Token } from '../../types';
import { mktOrderDecoder } from './mangrove';

const network = Network.ARBITRUM;
const srcTokenSymbol = 'WETH';
const srcToken = Tokens[network][srcTokenSymbol];

const destTokenSymbol = 'WBTC';
const destToken = Tokens[network][destTokenSymbol];

const tickSpacing = 1n;

const amounts = [
  0n,
  1n * BI_POWS[srcToken.decimals],
  3n * BI_POWS[srcToken.decimals],
  5n * BI_POWS[srcToken.decimals],
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

async function checkOnChainPricing(
  mangrove: Mangrove,
  funcName: string,
  blockNumber: number,
  prices: bigint[],
  amounts: bigint[],
  srcToken: Token,
  destToken: Token,
) {
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
    Number((Number(p) / Number(10n ** BigInt(destToken.decimals))).toFixed(6)),
  );
  const roundedPoolPrices = prices?.map(p =>
    Number((Number(p) / Number(10n ** BigInt(destToken.decimals))).toFixed(6)),
  );
  console.log('expectedPrices: ', roundedExpectedPrices);
  console.log('poolPrices: ', roundedPoolPrices);
  expect(roundedPoolPrices).toEqual(roundedExpectedPrices);

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
