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
  // console.log(`Fetching state ${message}`);
  const state = await mangrovePools.generateState(blockNumber);
  //  console.log('state', state);
  // console.log(`Done ${message}`);
  return state;
}

// eventName -> blockNumbers
type EventMappings = Record<string, number[]>;

describe('Mangrove Event', function () {
  const networkTokens = Tokens[network];
  const srcTokenSymbol = 'WETH'; // WETH
  const destTokenSymbol = 'USDT'; // USDT
  const poolAddress = '';
  const srcToken = networkTokens[srcTokenSymbol];
  const destToken = networkTokens[destTokenSymbol];
  const tickSpacing = 1n;

  const blockNumbers: { [eventName: string]: number[] } = {
    //OrderStart topic 0x730e8e2cc287cd5296445ccef0dcf7f0695d8b3d620dcc9dd19c671a6f5663a5
    ['OrderStart']: [255085839, 255086573],
    // //OrderComplete topic 0xeab9f920eda38e2e10cfc76b3f85201b8bbe82fac69de4c4509001b66e5e33af
    ['OrderComplete']: [255085839, 255086573],
    //     //OfferWrite topic 0xbeb2dc87c4db0b489fe0485121086dfff34fcaac67b1120861b95f1b6649c97b
    ['OfferWrite']: [
      254937505, 254939376, 254939623, 254939698, 254940129, 254940345,
      254940370, 254940491, 254940629, 254941221,
    ],
    // //OfferRetract topic 0x69a8c809e58310d1995905640ab3d1e8efe2ca772c21432a693da69912a478f1
    ['OfferRetract']: [254938197],

    // //OfferSuccess topic 0x5575d7d7c01adb4eeee1e2ec4a63652fdf5086d71fd325fa1af8034796b89904
    ['OfferSuccess']: [255085839, 255086573],
    // //OfferFail topic 0x8e83cc09450b5666c4b273f69ceff6631efac5291f291422fdc1e6e6c9223e19
    ['OfferFail']: [
      254937505, 254939376, 254939623, 254939698, 254940129, 254940345,
      254940370, 254940491, 254940629, 254941221, 254941236, 254946257,
      254946974, 254947058, 254947241, 254947511, 254947709, 254949019,
      254949034, 254949128, 254949451, 254949676, 254949885, 254952953,
      254952987, 254953315, 254953714, 254954287, 254954705, 254955218,
      254955417, 254955459, 254955543, 254955717, 254955793, 254956058,
      254956081, 254956942, 254956957, 254958236, 254958337, 254959449,
      254959776, 254959878, 254959937, 254960068, 254960225, 254960439,
      254960463, 254960496, 254960882, 254960951, 254960967, 254960983,
      254961495, 254961537, 254961645, 254961679, 254961692, 254961741,
      254961756, 254961806, 254961873, 254961888, 254961912, 254962006,
      254962047, 254963144, 254963194, 254963236, 254963251, 254963420,
      254963435, 254963493, 254963526, 254963980, 254964438, 254964716,
      254964869, 254964885, 254964976, 254965026, 254965504, 254965573,
      254965806, 254966106, 254966141, 254966218, 254966277, 254966301,
      254966482, 254966497,
    ],
    ['OfferSuccessWithPostHookData']: [249762602],
    ['OfferFailWithPostHookData']: [249762602],
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
            config.mangrove,
            srcToken.address,
            destToken.address,
            tickSpacing,
            logger,
          );

          const cacheKey = `${dexKey}_${mangrovePool.getPoolIdentifierData()}`;

          await testEventSubscriber(
            mangrovePool,
            [config.factory, config.reader], // just an address, not really important I think?
            (_blockNumber: number) =>
              fetchPoolState(mangrovePool, _blockNumber, cacheKey),
            blockNumber,
            cacheKey,
            dexHelper.provider,
          );
        });
      });
    });
  });
});
