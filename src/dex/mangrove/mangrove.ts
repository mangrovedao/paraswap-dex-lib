import { AsyncOrSync } from 'ts-essentials';
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
import { getBigIntPow, getDexKeysWithNetwork } from '../../utils';
import { IDex } from '../../dex/idex';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { MangroveData, OLKey, SingleMarket } from './types';
import { SimpleExchange } from '../simple-exchange';
import { MangroveConfig } from './config';
import IMangrove from '../../abi/mangrove/IMangrove.json';
import MgvReader from '../../abi/mangrove/MgvReader.json';

import { Interface } from '@ethersproject/abi';
import { BigNumber } from 'ethers';
import { NumberAsString } from '@paraswap/core';
import { OptimizedBalancerV1Data } from '../balancer-v1/types';

export class Mangrove extends SimpleExchange implements IDex<MangroveData> {
  readonly hasConstantPriceLargeAmounts = false;
  readonly needWrapNative = true;
  readonly isFeeOnTransferSupported = false;

  static mangroveIface = new Interface(IMangrove);
  static mgvReaderIface = new Interface(MgvReader);
  static MAX_TICK = 887_272n;

  public static dexKeysWithNetwork: { key: string; networks: Network[] }[] =
    getDexKeysWithNetwork(MangroveConfig);

  logger: Logger;

  public mangroveAddress: Address;
  public readerAddress: Address;

  constructor(
    readonly network: Network,
    readonly dexKey: string,
    readonly dexHelper: IDexHelper,
  ) {
    super(dexHelper, dexKey);
    this.logger = dexHelper.getLogger(dexKey);
    const config = MangroveConfig[dexKey][network];
    this.mangroveAddress = config.mangrove;
    this.readerAddress = config.reader;
  }

  toPoolIdentifier(olKey: OLKey) {
    return `${this.dexKey}_${olKey.outboundtoken}_${olKey.inboundtoken}_${olKey.tickSpacing}`;
  }

  static toOlKey(poolIdentifier: string) {
    const [, outboundtoken, inboundtoken, tickSpacing] =
      poolIdentifier.split('_');
    return {
      outboundtoken,
      inboundtoken,
      tickSpacing: BigInt(tickSpacing),
    } as OLKey;
  }

  // Legacy: was only used for V5
  // Returns the list of contract adapters (name and index)
  // for a buy/sell. Return null if there are no adapters.
  getAdapters(side: SwapSide): { name: string; index: number }[] | null {
    return null;
  }

  async getOpenMarkets() {
    const result = await this.dexHelper.multiContract.methods
      .aggregate([
        {
          target: this.readerAddress,
          callData: Mangrove.mgvReaderIface.encodeFunctionData('openMarkets'),
        },
      ])
      .call();
    const unformatted = Mangrove.mgvReaderIface.decodeFunctionResult(
      'openMarkets',
      result.returnData[0],
    );
    const markets: SingleMarket[] = [];
    for (let i = 0; i < unformatted[0].length; i++) {
      const unformattedMarket = unformatted[0][i];
      const unformattedMarketConfig01 = unformatted[1][i].config01;
      const unformattedMarketConfig10 = unformatted[1][i].config10;
      const market: SingleMarket = {
        tkn0: unformattedMarket.tkn0.toLowerCase(),
        tkn1: unformattedMarket.tkn1.toLowerCase(),
        tickSpacing: (unformattedMarket.tickSpacing as BigNumber).toBigInt(),
        config01: {
          fee: (unformattedMarketConfig01.fee as BigNumber).toBigInt(),
          active: unformattedMarketConfig01.active,
          gasbase:
            (
              unformattedMarketConfig01.kilo_offer_gasbase as BigNumber
            ).toBigInt() * 1_000n,
        },
        config10: {
          fee: (unformattedMarketConfig10.fee as BigNumber).toBigInt(),
          active: unformattedMarketConfig10.active,
          gasbase:
            (
              unformattedMarketConfig10.kilo_offer_gasbase as BigNumber
            ).toBigInt() * 1_000n,
        },
      };
      markets.push(market);
    }
    return markets;
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
    const _srcToken = this.dexHelper.config.wrapETH(srcToken);
    const _destToken = this.dexHelper.config.wrapETH(destToken);

    const _srcAddress = _srcToken.address.toLowerCase();
    const _destAddress = _destToken.address.toLowerCase();

    if (_srcAddress === _destAddress) return [];

    const openMarkets = await this.getOpenMarkets();

    const markets = openMarkets.filter(market => {
      if (!market.config01.active || !market.config10.active) return false;
      return (
        (market.tkn0 === _srcAddress && market.tkn1 === _destAddress) ||
        (market.tkn0 === _destAddress && market.tkn1 === _srcAddress)
      );
    });

    return markets.map(market => {
      return `${this.dexKey}_${_destAddress}_${_srcAddress}_${market.tickSpacing}`;
    });
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
    limitPools?: string[],
  ): Promise<null | ExchangePrices<MangroveData>> {
    // mangrove is applying fee on the bought token
    // buy ~ exact amount out which is going to be unprecise.
    if (side === SwapSide.BUY) return null;

    const olKeys: OLKey[] = [];
    const _srcToken = this.dexHelper.config.wrapETH(srcToken);
    const _destToken = this.dexHelper.config.wrapETH(destToken);
    const _srcAddress = _srcToken.address.toLowerCase();
    const _destAddress = _destToken.address.toLowerCase();

    // since we are selling here only, the unit volume is going to be the src token decimals
    const unitVolume = getBigIntPow(_srcToken.decimals);

    if (limitPools) {
      olKeys.push(
        ...limitPools.map(pool => {
          const [, outboundtoken, inboundtoken, tickSpacing] = pool.split('_');
          return {
            outboundtoken,
            inboundtoken,
            tickSpacing: BigInt(tickSpacing),
          } as OLKey;
        }),
      );
    } else {
      const openMarkets = await this.getOpenMarkets();
      const markets = openMarkets.filter(market => {
        return (
          (market.tkn0 === _srcAddress && market.tkn1 === _destAddress) ||
          (market.tkn0 === _destAddress && market.tkn1 === _srcAddress)
        );
      });
      olKeys.push(
        ...markets.map(market => {
          return {
            outboundtoken: market.tkn0,
            inboundtoken: market.tkn1,
            tickSpacing: market.tickSpacing,
          } as OLKey;
        }),
      );
    }

    const outAmounts = await this._getOutAmounts(olKeys, [...amounts]);
    return outAmounts.map(outAmount => {
      return {
        prices: outAmount.received,
        unit: outAmount.received[0],
        exchange: this.dexKey,
        data: {
          exchange: this.mangroveAddress,
          olKey: outAmount.olKey,
        },
        gasCost: outAmount.gasCost.map(Number),
        poolIdentifier: `${this.dexKey}_${outAmount.olKey.outboundtoken}_${outAmount.olKey.inboundtoken}_${outAmount.olKey.tickSpacing}`,
      } as PoolPrices<MangroveData>;
    });
  }

  async _getOutAmounts(
    olKeys: OLKey[],
    amounts: bigint[],
  ): Promise<
    { sent: bigint[]; received: bigint[]; gasCost: bigint[]; olKey: OLKey }[]
  > {
    const calls = olKeys.flatMap(olKey => {
      return amounts.map(amount => ({
        target: this.readerAddress,
        callData: Mangrove.mgvReaderIface.encodeFunctionData(
          'simulateMarketOrderByTick',
          [
            [olKey.outboundtoken, olKey.inboundtoken, olKey.tickSpacing],
            Mangrove.MAX_TICK, // maxTick - use maximum possible tick
            amount,
            false, // fillWants = false since we're selling exact input amount
          ],
        ),
      }));
    });

    const rawResult = await this.dexHelper.multiContract.methods
      .aggregate(calls)
      .call();

    const decoded: { received: bigint; gasCost: bigint }[] =
      rawResult.returnData.map((data: any) => {
        const decodedData = Mangrove.mgvReaderIface
          .decodeFunctionResult('simulateMarketOrderByTick', data)
          .at(0);
        const nOffers = decodedData?.length || 0;
        const finalData = decodedData?.at(-1);
        if (!finalData) return { received: 0n, gasCost: 0n };
        return {
          received: (finalData.totalGot as BigNumber).toBigInt(),
          gasCost:
            (finalData.totalGasreq as BigNumber).toBigInt() +
            250_000n * BigInt(nOffers),
        };
      });

    // Group results by olKey
    const result: {
      sent: bigint[];
      received: bigint[];
      gasCost: bigint[];
      olKey: OLKey;
    }[] = [];
    for (let olKeyIndex = 0; olKeyIndex < olKeys.length; olKeyIndex++) {
      const sentAmounts: bigint[] = [];
      const receivedAmounts: bigint[] = [];
      const gasCosts: bigint[] = [];

      for (let amountIndex = 0; amountIndex < amounts.length; amountIndex++) {
        const decodedIndex = olKeyIndex * amounts.length + amountIndex;
        sentAmounts.push(amounts[amountIndex]);
        receivedAmounts.push(decoded[decodedIndex].received);
        gasCosts.push(decoded[decodedIndex].gasCost);
      }

      result.push({
        sent: sentAmounts,
        received: receivedAmounts,
        gasCost: gasCosts,
        olKey: olKeys[olKeyIndex],
      });
    }

    return result;
  }

  // Returns estimated gas cost of calldata for this DEX in multiSwap
  getCalldataGasCost(poolPrices: PoolPrices<MangroveData>): number | number[] {
    return (
      CALLDATA_GAS_COST.DEX_NO_PAYLOAD +
      CALLDATA_GAS_COST.FUNCTION_SELECTOR +
      CALLDATA_GAS_COST.ADDRESS + // outbound token
      CALLDATA_GAS_COST.ADDRESS + // inbound token
      CALLDATA_GAS_COST.LENGTH_LARGE + // tickSpacing
      CALLDATA_GAS_COST.FULL_WORD + // maxTick
      CALLDATA_GAS_COST.AMOUNT + // amount
      CALLDATA_GAS_COST.BOOL // fillWants
    );
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
    const { exchange } = data;

    // Encode here the payload for adapter
    const payload = '';

    return {
      targetExchange: exchange,
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
    return [];
  }

  // This is optional function in case if your implementation has acquired any resources
  // you need to release for graceful shutdown. For example, it may be any interval timer
  releaseResources(): AsyncOrSync<void> {
    // TODO: complete me!
  }

  getDexParam(
    srcToken: Address,
    destToken: Address,
    srcAmount: NumberAsString,
    destAmount: NumberAsString,
    recipient: Address,
    data: any,
    side: SwapSide,
  ): DexExchangeParam {
    const exchangeData = Mangrove.mangroveIface.encodeFunctionData(
      'marketOrderByVolume',
      [[destToken, srcToken, 1], destAmount, srcAmount, false],
    );
    return {
      exchangeData,
      needWrapNative: this.needWrapNative,
      dexFuncHasRecipient: false,
      targetExchange: this.mangroveAddress,
      returnAmountPos: undefined,
    };
  }
}
