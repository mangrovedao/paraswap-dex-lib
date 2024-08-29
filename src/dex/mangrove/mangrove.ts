import { AsyncOrSync, DeepReadonly } from 'ts-essentials';
import { defaultAbiCoder, Interface } from '@ethersproject/abi';

import {
  Token,
  Address,
  ExchangePrices,
  PoolPrices,
  AdapterExchangeParam,
  SimpleExchangeParam,
  PoolLiquidity,
  Logger,
} from '../../types';
import { SwapSide, Network } from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getDexKeysWithNetwork, isTruthy, interpolate } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { MangroveData, PoolState } from './types';
import { SimpleExchange } from '../simple-exchange';
import { MangroveConfig, Adapters } from './config';
import { MangroveEventPool } from './mangrove-pool';
import { OnPoolCreatedCallback, MangroveFactory } from './mangrove-factory';
import { Pool } from '@hashflow/sdk/dist/modules/Pool';
import MangroveMultiABI from '../../abi/mangrove/MangroveMulti.abi.json';
import MangroveABI from '../../abi/mangrove/Mangrove.abi.json';
import { AbiItem } from 'web3-utils';
import { Contract } from 'web3-eth-contract';
import { generalDecoder } from '../../lib/decoders';
import { BytesLike } from 'ethers/lib/utils';
import { extractSuccessAndValue } from '../../lib/decoders';
import { assert } from 'ts-essentials';
import { MultiResult } from '../../lib/multi-wrapper';
// export type ExchangePrices<T> = PoolPrices<T>[];

// export type PoolPrices<T> = {
//   prices: bigint[];
//   unit: bigint;
//   data: T;
//   poolIdentifier?: string;
//   exchange: string;
//   gasCost: number | number[];
//   gasCostL2?: number | number[];
//   poolAddresses?: Array<Address>;
// };
export const mktOrderDecoder = (
  result: MultiResult<BytesLike> | BytesLike,
): ExchangePrices<MangroveData> => {
  const [isSuccess, toDecode] = extractSuccessAndValue(result);
  assert(
    isSuccess && toDecode !== '0x',
    `mktOrderDecoder failed to get decodable result: ${result}`,
  );
  const mgvData: MangroveData = {
    path: {
      tokenIn: '',
      tokenOut: '',
      tickSpacing: 1n,
    },
  };
  let poolPrices: PoolPrices<MangroveData> = {
    prices: [0n],
    unit: 0n,
    data: mgvData,
    exchange: 'Mangrove',
    gasCost: 0,
  };

  let res: ExchangePrices<MangroveData> = [];

  return generalDecoder(
    result,
    ['uint256', 'uint256', 'uint256', 'uint256'],
    res,
    value => {
      //takerGot, takerGave, bounty, feePaid
      console.log(value);
      poolPrices.prices[0] = value[0];
      res.push(poolPrices);
      return res;
    },
  );
};

export class Mangrove extends SimpleExchange implements IDex<MangroveData> {
  public readonly factory: MangroveFactory;
  protected eventPools: Record<string, MangroveEventPool | null> = {};

  readonly hasConstantPriceLargeAmounts = false;
  // TODO: set true here if protocols works only with wrapped asset
  readonly needWrapNative = true;

  readonly isFeeOnTransferSupported = false;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(MangroveConfig);

  logger: Logger;
  private mangroveMulti: Contract;

  protected notExistingPoolSetKey: string;

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
    protected adapters = Adapters[network] || {}, // TODO: add any additional optional params to support other fork DEXes
    protected config = MangroveConfig[dexKey][network],
    readonly mangroveIface = new Interface(MangroveABI),
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    this.notExistingPoolSetKey =
      `${network}_${dexKey}_not_existings_pool_set`.toLowerCase();
    this.factory = this.getFactoryInstance();

    this.mangroveMulti = new this.dexHelper.web3Provider.eth.Contract(
      MangroveMultiABI as AbiItem[],
      this.config.mangroveMulticall,
    );
  }

  protected onPoolCreated(): OnPoolCreatedCallback {
    return async ({
      olKeyHash,
      outbound_tkn,
      inbound_tkn,
      tickSpacing,
      value,
    }) => {
      return Promise.resolve();
    };
  }

  // Initialize pricing is called once in the start of
  // pricing service. It is intended to setup the integration
  // for pricing requests. It is optional for a DEX to
  // implement this function
  async initializePricing(blockNumber: number) {
    await this.factory.initialize(blockNumber);
  }

  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return this.adapters[side] ? this.adapters[side] : null;
  }

  getPoolIdentifier(
    srcAddress: Address,
    destAddress: Address,
    tickSpacing: bigint = 1n,
  ) {
    return `${this.dexKey}_${srcAddress}_${destAddress}${tickSpacing}`;
  }

  // Returns list of pool identifiers that can be used
  // for a given swap. poolIdentifiers must be unique
  // across DEXes. It is recommended to use
  // ${dexKey}_${poolAddress} as a poolIdentifier
  async getPoolIdentifiers(
    srcToken: Token,
    destToken: Token,
    side: SwapSide,
    blockNumber: number,
  ): Promise<string[]> {
    // TODO: complete me!
    return [];
  }

  protected getPoolInstance(
    srcAddress: string,
    destAddress: string,
    tickSpacing: bigint,
  ) {
    return new MangroveEventPool(
      this.dexKey,
      this.dexHelper,
      this.config.factory,
      this.config.reader,
      srcAddress,
      destAddress,
      tickSpacing,
      this.logger,
    );
  }

  async getPool(
    srcAddress: Address,
    destAddress: Address,
    tickSpacing: bigint,
    blockNumber: number,
  ): Promise<MangroveEventPool | null> {
    let pool = this.eventPools[
      this.getPoolIdentifier(srcAddress, destAddress, tickSpacing)
    ] as MangroveEventPool | null | undefined;

    if (pool === null) return null;
    if (pool) {
      if (!pool.initFailed) {
        return pool;
      } else {
        // if init failed then prefer to early return pool with empty state to fallback to rpc call
        if (
          ++pool.initRetryAttemptCount % this.config.initRetryFrequency !==
          0
        ) {
          return pool;
        }
        // else pursue with re-try initialization
      }
    }

    let olKey = `${srcAddress}_${destAddress}_${tickSpacing}`.toLowerCase();

    this.logger.trace(`starting to listen to new pool: ${olKey}`);

    pool = pool || this.getPoolInstance(srcAddress, destAddress, tickSpacing);

    try {
      await pool.initialize(blockNumber);
    } catch (e) {
      if (e instanceof Error && e.message.endsWith('Pool does not exist')) {
        // no need to await we want the set to have the pool key but it's not blocking
        this.dexHelper.cache.zadd(
          this.notExistingPoolSetKey,
          [Date.now(), olKey],
          'NX',
        );

        // Pool does not exist for this feeCode, so we can set it to null
        // to prevent more requests for this pool
        pool = null;
        this.logger.trace(
          `${this.dexHelper}: Pool: srcAddress=${srcAddress}, destAddress=${destAddress}, tickSpacing=${tickSpacing} not found`,
          e,
        );
      } else {
        // on unknown error mark as failed and increase retryCount for retry init strategy
        // note: state would be null by default which allows to fallback
        this.logger.warn(
          `${this.dexKey}: Can not generate pool state for srcAddress=${srcAddress}, destAddress=${destAddress}, tickSpacing=${tickSpacing} pool fallback to rpc and retry every ${this.config.initRetryFrequency} times, initRetryAttemptCount=${pool.initRetryAttemptCount}`,
          e,
        );
        pool.initFailed = true;
      }
    }

    this.eventPools[
      this.getPoolIdentifier(srcAddress, destAddress, tickSpacing)
    ] = pool;
    return pool;
  }
  // Returns pool prices for amounts.
  // If limitPools is defined only pools in limitPools
  // should be used. If limitPools is undefined then
  // any pools can be used.
  async getPricesVolume(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
  ): Promise<null | ExchangePrices<MangroveData>> {
    // TODO: complete me!
    // try {
    //   const _srcToken = this.dexHelper.config.wrapETH(srcToken);
    //   const _destToken = this.dexHelper.config.wrapETH(destToken);

    //   const _srcAddress = _srcToken.address.toLowerCase();
    //   const _destAddress = _destToken.address.toLowerCase();
    //   if (_srcAddress === _destAddress) return null;
    //   let pool: MangroveEventPool | null;

    //   const poolIdentifier = this.getPoolIdentifier(_srcAddress, _destAddress, tickSpacing);

    //   pool = await this.getPool(_srcAddress, _destAddress, tickSpacing, blockNumber);
    //   if (pool === null) {
    //     return null;
    //   }
    //   const state = pool.getState(blockNumber);

    //   return null;
    // } catch (e) {
    //   this.logger.error(
    //     `Error_getPricesVolume ${srcToken.symbol || srcToken.address}, ${
    //       destToken.symbol || destToken.address
    //     }, ${side}:`,
    //     e,
    //   );
    //   return null;
    // }
    return null;
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(poolPrices: PoolPrices<MangroveData>): number | number[] {
    // TODO: update if there is any payload in getAdapterParam
    return CALLDATA_GAS_COST.DEX_NO_PAYLOAD;
  }

  // Encode params required by the exchange adapter
  // V5: Used for multiSwap, buy & megaSwap
  // V6: Not used, can be left blank
  // Hint: abiCoder.encodeParameter() could be useful
  getAdapterParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    data: MangroveData,
    side: SwapSide,
  ): AdapterExchangeParam {
    // TODO: complete me!
    //const { exchange } = data;

    // Encode here the payload for adapter
    const payload = '';

    return {
      targetExchange: this.dexKey,
      payload,
      networkFee: '0',
    };
  }

  // This is called once before getTopPoolsForToken is
  // called for multiple tokens. This can be helpful to
  // update common state required for calculating
  // getTopPoolsForToken. It is optional for a DEX
  // to implement this
  async updatePoolState(): Promise<void> {
    // TODO: complete me!
  }

  // Returns list of top pools based on liquidity. Max
  // limit number pools should be returned.
  async getTopPoolsForToken(
    tokenAddress: Address,
    limit: number,
  ): Promise<PoolLiquidity[]> {
    //TODO: complete me!
    return [];
  }

  // This is optional function in case if your implementation has acquired any resources
  // you need to release for graceful shutdown. For example, it may be any interval timer
  releaseResources(): AsyncOrSync<void> {
    // TODO: complete me!
  }

  protected getFactoryInstance(): MangroveFactory {
    const factoryImplementation =
      this.config.factoryImplementation !== undefined
        ? this.config.factoryImplementation
        : MangroveFactory;

    return new factoryImplementation(
      this.dexHelper,
      this.dexKey,
      this.config.factory,
      this.logger,
      this.onPoolCreated(),
    );
  }

  protected _sortTokens(srcAddress: Address, destAddress: Address) {
    return [srcAddress, destAddress].sort((a, b) => (a < b ? -1 : 1));
  }

  async getPricingFromRpc(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    pool: MangroveEventPool,
    state?: PoolState,
    max_tick: number = 887272,
    fill_wants: boolean = false,
  ): Promise<ExchangePrices<MangroveData> | null> {
    if (!pool) {
      return null;
    }

    console.log(pool.olKey);

    const callData = amounts.map(amount => ({
      target: this.config.mangrove,
      gasLimit: 20000000, // TO DO
      callData: this.mangroveIface.encodeFunctionData('marketOrderByTick', [
        pool.olKey,
        max_tick,
        amount,
        fill_wants,
      ]),
      decodeFunction: mktOrderDecoder,
    }));

    let pricingResult: ExchangePrices<MangroveData> = [];
    const rpcResult = await this.dexHelper.multiWrapper.tryAggregate<
      ExchangePrices<MangroveData>
    >(
      false,
      callData,
      state?.blockNumber,
      this.dexHelper.multiWrapper.defaultBatchSize,
      false,
    );

    let res = rpcResult[0].success ? rpcResult[0].returnData : null;

    return res;
  }
}
