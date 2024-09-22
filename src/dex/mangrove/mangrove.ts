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
    prices: [0n],
    unit: 0n,
    data: mgvData,
    exchange: 'Mangrove',
    gasCost: [] as number[],
  };

  let res: ExchangePrices<MangroveData> = [];

  const abi = ['tuple(uint256,uint256,uint256)[]'];
  const decodedResult = defaultAbiCoder.decode(abi, toDecode);
  const lastTuple = decodedResult[0][decodedResult[0].length - 1];
  //takerGot, takerGave, totalGasReq
  const takerGot = BigInt(lastTuple[0].toString());
  const takerGave = BigInt(lastTuple[1].toString());
  const totalGasReq = BigInt(lastTuple[2].toString());
  poolPrices.prices[0] = takerGot;
  (poolPrices.gasCost as number[])[0] = Number(totalGasReq);

  return [poolPrices];
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
      this.config.mangrove,
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

  getMktPrice(
    state: DeepReadonly<PoolState>,
    amountIn: bigint,
    fee: bigint = 2n,
  ): [bigint, bigint] {
    // result has to be in units of destToken
    // Function that goes through the orderbook until amountIn is 0
    // see: https://docs.mangrove.exchange/developers/protocol/technical-references/tick-ratio

    try {
      let offers = [...state.offers].sort((a, b) => {
        if (a.tick < b.tick) return -1;
        if (a.tick > b.tick) return 1;
        return 0;
      });

      let res: bigint = 0n;
      // reamining IN tokens to spend
      let remainingQty: bigint = amountIn;
      let offerIndex = 0;
      let gasBase: bigint = state.offersDetail[0].kilo_offer_gasbase * 1000n; // same for all offers on market
      let gasCost: bigint = 0n;
      while (remainingQty > 0) {
        if (offerIndex == offers.length) {
          this.logger.error(
            `Not enough liquidity in pool for amount ${amountIn}`,
          );
          this.logger.log(
            `Not enough liquidity in pool for amount ${amountIn}`,
          );
          return [-1n, -1n];
        }

        let topOffer = offers[offerIndex];
        let priceFromTick = 1.0001 ** Number(topOffer.tick);
        let topOfferWants = Math.floor(priceFromTick * Number(topOffer.gives)); // TO DO: is floor ok here?
        if (remainingQty < topOfferWants) {
          res += BigInt(Math.ceil(Number(remainingQty) / priceFromTick)); // TO DO review this
          remainingQty = 0n;
          gasCost += state.offersDetail[offerIndex].gasreq;
          offerIndex += 1;
        } else {
          res += topOffer.gives;
          remainingQty -= BigInt(topOfferWants);
          gasCost += state.offersDetail[offerIndex].gasreq;
          offerIndex += 1;
        }
      }
      const feePaid = (BigInt(res) * fee) / 10000n;
      gasCost += gasBase * BigInt(offerIndex + 1);
      return [BigInt(res) - feePaid, gasCost];
    } catch (e) {
      this.logger.debug(
        `${this.dexKey}: received error in getMktPrice while calculating outputs`,
        e,
      );
      return [-1n, -1n];
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
      if (state.offers.length == 0) {
        this.logger.trace(`pool has 0 liquidity`);
        return null;
      }

      const unitAmount = getBigIntPow(_srcToken.decimals);
      const unitResult = this.getMktPrice(state, unitAmount);

      const prices: bigint[] = [];
      const gasCosts: number[] = [];

      for (const amount of amounts) {
        if (amount === 0n) continue;
        const [price, gasCost] = this.getMktPrice(state, amount);
        if (price !== -1n && gasCost !== -1n) {
          prices.push(price);
          gasCosts.push(Number(gasCost));
        }
      }

      if (prices.length === 0 || gasCosts.length === 0) {
        this.logger.debug('No valid prices or gas costs calculated');
        return null;
      }

      return [
        {
          unit: unitResult[0],
          prices,
          data: this.prepareData(_srcToken.address, _destToken.address),
          poolIdentifier: this.getPoolIdentifier(
            _srcToken.address,
            _destToken.address,
          ),
          exchange: this.dexKey,
          gasCost: gasCosts,
          poolAddresses: undefined,
        },
      ];
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

    const _amounts = amounts.filter(amount => amount > 0n);
    const callData = _amounts.map(amount => ({
      target: this.config.reader,
      gasLimit: 20000000,
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

    const aggregatedResult: ExchangePrices<MangroveData> = [
      {
        prices: [],
        unit: 0n,
        data: { path: rpcResult[0].returnData[0].data.path },
        exchange: 'Mangrove',
        gasCost: [] as number[],
      },
    ];

    rpcResult.forEach(result => {
      if (result.success && result.returnData.length > 0) {
        const data = result.returnData[0];
        aggregatedResult[0].prices.push(...data.prices);
        if (Array.isArray(aggregatedResult[0].gasCost)) {
          aggregatedResult[0].gasCost.push(
            ...(Array.isArray(data.gasCost) ? data.gasCost : [data.gasCost]),
          );
        } else {
          aggregatedResult[0].gasCost = [
            ...(Array.isArray(aggregatedResult[0].gasCost)
              ? [aggregatedResult[0].gasCost]
              : []),
            ...(Array.isArray(data.gasCost) ? data.gasCost : [data.gasCost]),
          ];
        }
      }
    });

    return aggregatedResult;
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
