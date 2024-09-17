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
  DexExchangeParam,
} from '../../types';
import { SwapSide, Network } from '../../constants';
import * as CALLDATA_GAS_COST from '../../calldata-gas-cost';
import { getDexKeysWithNetwork, getBigIntPow, interpolate } from '../../utils';
import { Context, IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { MangroveData, PoolState } from './types';
import { SimpleExchange } from '../simple-exchange';
import { MangroveConfig, Adapters } from './config';
import { MangroveEventPool } from './mangrove-pool';
import { OnPoolCreatedCallback, MangroveFactory } from './mangrove-factory';
import { Pool } from '@hashflow/sdk/dist/modules/Pool';
import MangroveMultiABI from '../../abi/mangrove/MangroveMulti.abi.json';
import MangroveABI from '../../abi/mangrove/Mangrove.abi.json';
import MangroveReader from '../../abi/mangrove/MangroveReader.abi.json';
import { AbiItem } from 'web3-utils';
import { Contract } from 'web3-eth-contract';
import { generalDecoder } from '../../lib/decoders';
import { BytesLike } from 'ethers/lib/utils';
import { extractSuccessAndValue } from '../../lib/decoders';
import { assert } from 'ts-essentials';
import { MultiResult } from '../../lib/multi-wrapper';
import { BI_POWS } from '../../bigint-constants';
import { read } from 'fs';

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
    prices: [0n, 0n],
    unit: 0n,
    data: mgvData,
    exchange: 'Mangrove',
    gasCost: 0,
  };

  let res: ExchangePrices<MangroveData> = [];

  return generalDecoder(result, ['uint256', 'uint256'], res, value => {
    //takerGot, takerGave, totalGasReq
    poolPrices.prices[0] = BigInt(value[0].toString());
    poolPrices.prices[1] = BigInt(value[1].toString());
    //res.push(poolPrices);
    return res;
  });
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
    readonly mgvReaderIface = new Interface(MangroveReader),
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
    return `${this.dexKey}_${destAddress}_${srcAddress}${tickSpacing}`;
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
    blockNumber?: number,
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

    let olKey = `${destAddress}_${srcAddress}_${tickSpacing}`.toLowerCase();

    this.logger.trace(`starting to listen to new pool: ${olKey}`);

    pool = pool || this.getPoolInstance(srcAddress, destAddress, tickSpacing);

    try {
      if (!blockNumber)
        blockNumber = await this.dexHelper.web3Provider.eth.getBlockNumber();

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

  protected prepareData(
    srcAddress: string,
    destAddress: string,
    tickSpacing: bigint = 1n,
  ): MangroveData {
    return {
      path: {
        tokenIn: srcAddress,
        tokenOut: destAddress,
        tickSpacing: tickSpacing,
      },
    };
  }

  getMktPrice(state: DeepReadonly<PoolState>, amountIn: bigint): bigint {
    // result has to be in units of destToken
    // Function that goes through the orderbook until amountIn is 0
    // see: https://docs.mangrove.exchange/developers/protocol/technical-references/tick-ratio

    try {
      let offers = [...state.offers].sort((a, b) => {
        if (a.tick < b.tick) return -1;
        if (a.tick > b.tick) return 1;
        return 0;
      });

      let res: number = 0;
      // reamining IN tokens to spend
      let remainingQty: bigint = amountIn;
      let offerIndex = 0;

      while (remainingQty > 0) {
        if (offerIndex == offers.length) {
          this.logger.error(
            `Not enough liquidity in pool for amount ${amountIn}`,
          );
          this.logger.log(
            `Not enough liquidity in pool for amount ${amountIn}`,
          );
          return -1n;
        }

        let topOffer = offers[offerIndex];
        let priceFromTick = 1.0001 ** Number(topOffer.tick);
        let topOfferWants = Math.floor(priceFromTick * Number(topOffer.gives)); // TO DO: is floor ok here?

        if (remainingQty < topOfferWants) {
          res = Math.ceil(Number(remainingQty) / priceFromTick); // TO DO review this
          remainingQty = 0n;
          offerIndex += 1;
        } else {
          res += Math.ceil(Number(remainingQty) / priceFromTick);
          remainingQty -= BigInt(topOfferWants);
          offerIndex += 1;
        }
      }
      return BigInt(res);
    } catch (e) {
      this.logger.debug(
        `${this.dexKey}: received error in getMktPrice while calculating outputs`,
        e,
      );
      return -1n;
    }
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
    try {
      const _srcToken = this.dexHelper.config.wrapETH(srcToken);
      const _destToken = this.dexHelper.config.wrapETH(destToken);

      const pool = await this.getPool(
        _srcToken.address,
        _destToken.address,
        1n,
      );
      if (!pool) return null;

      const state = pool.getState(blockNumber);

      if (!state) return null;

      const unitAmount = getBigIntPow(_srcToken.decimals);
      const _amounts = [...amounts.slice(1)];

      const result = _amounts.map(a => {
        if (state.offers.length == 0) {
          this.logger.trace(`pool has 0 liquidity`);
          return null;
        }

        const unitResult = this.getMktPrice(state, unitAmount);

        const priceResult = this.getMktPrice(state, a);

        if (!unitResult || !priceResult) {
          this.logger.debug('Prices or unit is not calculated');
          return null;
        }
        let gasCost = 0; // TODO

        return {
          unit: unitResult,
          prices: [priceResult],
          data: this.prepareData(_destToken.address, _srcToken.address),
          poolIdentifier: this.getPoolIdentifier(
            _srcToken.address,
            _destToken.address,
          ),
          exchange: this.dexKey,
          gasCost: gasCost,
          poolAddresses: undefined,
        };
      });

      // const rpcResult = this.getPricingFromRpc(_srcToken, _destToken,
      //    amounts); // WHAT TO DO WITH THIS?

      const notNullResult = result.filter(
        res => res !== null,
      ) as ExchangePrices<MangroveData>;

      return notNullResult;
    } catch (e) {
      this.logger.error(
        `Error_getPricesVolume ${srcToken.symbol || srcToken.address}, ${
          destToken.symbol || destToken.address
        }`,
        e,
      );
      return null;
    }
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

  async getPricingFromRpc(
    srcToken: Token,
    destToken: Token,
    amounts: bigint[],
    state?: PoolState,
    maxTick: number = 887272,
    fillWants: boolean = false,
  ): Promise<ExchangePrices<MangroveData> | null> {
    let pool = await this.getPool(srcToken.address, destToken.address, 1n);

    if (!pool) {
      return null;
    }

    const callData = amounts.map(amount => ({
      target: this.config.reader,
      gasLimit: 20000000, // TO DO
      callData: this.mgvReaderIface.encodeFunctionData(
        'simulateMarketOrderByTick((address, address, uint256), int256, uint256, bool)',
        [pool?.getPoolIdentifierData(), maxTick, amount, fillWants],
      ),
      decodeFunction: mktOrderDecoder,
    }));

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

  async getDexParam(
    srcToken: string,
    destToken: string,
    srcAmount: string,
    destAmount: string,
    recipient: string,
    data: MangroveData,
    side: SwapSide,
    context: Context,
    executorAddress: string,
    tickSpacing: bigint = 1n,
    maxTick: number = 887272,
    fillWants: boolean = false,
  ): Promise<DexExchangeParam> {
    const srcAddress = this.dexHelper.config.wrapETH(srcToken);
    const destAddress = this.dexHelper.config.wrapETH(destToken);

    const olkey = [destAddress, srcAddress, 1n]; // TO DO CHECK CORRECT ORDER

    const exchangeData = this.mangroveIface.encodeFunctionData(
      'mktOrderByTick',
      [olkey, maxTick, srcAmount, fillWants],
    );

    return {
      needWrapNative: this.needWrapNative,
      dexFuncHasRecipient: false,
      exchangeData,
      targetExchange: this.config.mangrove,
      returnAmountPos: 0,
    };
  }
}
