import { Address } from '../../types';
import { MangroveFactory } from './mangrove-factory';
import { MangroveEventPool } from './mangrove-pool';

export type OlKey = [string, string, bigint];

export type Offer = {
  prev: bigint;
  next: bigint;
  tick: bigint;
  gives: bigint;
};

export type OfferDetail = {
  maker: string;
  gasreq: bigint;
  kilo_offer_gasbase: bigint;
  gasprice: bigint;
};

// Mangrove semi book
export type DecodedStateMultiCallResult = {
  blockNumber: number;
  nextOffer: bigint;
  offersIds: bigint[];
  offers: Offer[];
  offersDetail: OfferDetail[];
};

export type PoolState = {
  blockNumber: number;
  nextOffer: bigint;
  offersIds: bigint[];
  offers: Offer[];
  offersDetail: OfferDetail[];
};

export type MangroveData = {
  // TODO: MangroveData is the dex data that is
  // returned by the API that can be used for
  // tx building. The data structure should be minimal.
  // Complete me!
  path: {
    tokenIn: Address;
    tokenOut: Address;
    tickSpacing: bigint;
  };
};

export type DexParams = {
  factory: Address;
  mangrove: Address;
  reader: Address;
  mangroveMulticall: Address;
  makerAddress: Address;
  initRetryFrequency: number;
  factoryImplementation?: typeof MangroveFactory;
  eventPoolImplementation?: typeof MangroveEventPool;
};
