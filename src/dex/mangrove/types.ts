import { BigNumber } from 'ethers';
import { Address } from '../../types';

export type PoolState = {
  // TODO: poolState is the state of event
  // subscriber. This should be the minimum
  // set of parameters required to compute
  // pool prices. Complete me!
};

export type MangroveData = {
  // TODO: MangroveData is the dex data that is
  // returned by the API that can be used for
  // tx building. The data structure should be minimal.
  // Complete me!
  exchange: Address;
  olKey: OLKey;
};

export type DexParams = {
  mangrove: Address;
  reader: Address;
};

type SemiMarketConfig = {
  fee: bigint
  active: boolean
  gasbase: bigint
}

export type SingleMarket = {
  tkn0: Address
  tkn1: Address
  tickSpacing: bigint
  config01: SemiMarketConfig
  config10: SemiMarketConfig
}

export type OpenMarkets = Array<SingleMarket>

export type OLKey = {
  outboundtoken: Address  
  inboundtoken: Address
  tickSpacing: bigint
}
