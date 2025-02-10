import { DexParams } from './types';
import { DexConfigMap } from '../../types';
import { Network, SwapSide } from '../../constants';

export const MangroveConfig: DexConfigMap<DexParams> = {
  Mangrove: {
    [Network.ARBITRUM]: {
      mangrove: '0x109d9CDFA4aC534354873EF634EF63C235F93f61',
      reader: '0x7E108d7C9CADb03E026075Bf242aC2353d0D1875',
    },
  },
};
