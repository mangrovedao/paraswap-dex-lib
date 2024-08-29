import { DexParams } from './types';
import { DexConfigMap, AdapterMappings } from '../../types';
import { Network, SwapSide } from '../../constants';
import { MangroveEventPool } from './mangrove-pool';

export const MangroveConfig: DexConfigMap<DexParams> = {
  Mangrove: {
    [Network.ARBITRUM]: {
      factory: '0x109d9CDFA4aC534354873EF634EF63C235F93f61',
      mangrove: '0x109d9CDFA4aC534354873EF634EF63C235F93f61',
      reader: '0x7E108d7C9CADb03E026075Bf242aC2353d0D1875',
      makerAddress: '0xFEF521796B0Aaa6dF82Be685bf13cA84FA5a4c99', // needs to have funds !
      mangroveMulticall: '0x842eC2c7D803033Edf55E478F461FC547Bc54EB2',
      initRetryFrequency: 10,
      eventPoolImplementation: MangroveEventPool,
    },
  },
};

export const Adapters: Record<number, AdapterMappings> = {
  // TODO: add adapters for each chain
  // This is an example to copy
  [Network.MAINNET]: { [SwapSide.SELL]: [{ name: '', index: 0 }] },
};
