import _ from 'lodash';
import { Interface } from '@ethersproject/abi';
import { DeepReadonly } from 'ts-essentials';
import { MultiCallParams } from '../../lib/multi-wrapper';
import { Log, Logger, Address } from '../../types';
import { catchParseLogError, bigIntify } from '../../utils';
import {
  InitializeStateOptions,
  StatefulEventSubscriber,
} from '../../stateful-event-subscriber';
import { IDexHelper } from '../../dex-helper/idex-helper';
import { PoolState, DecodedStateMultiCallResult } from './types';
import MangroveReaderABI from '../../abi/mangrove/MangroveReader.abi.json';
import { generalDecoder } from '../../lib/decoders';
import { MultiResult } from '../../lib/multi-wrapper';
import { BytesLike, AbiCoder } from 'ethers/lib/utils';
import { keccak256 } from 'web3-utils';

import { extractSuccessAndValue } from '../../lib/decoders';
import { assert } from 'ts-essentials';

import BigNumber from 'bignumber.js';

import MangroveABI from '../../abi/mangrove/Mangrove.abi.json';

export const poolStateDecoder = (
  result: MultiResult<BytesLike> | BytesLike,
): PoolState => {
  const [isSuccess, toDecode] = extractSuccessAndValue(result);
  assert(
    isSuccess && toDecode !== '0x',
    `poolStateDecoder failed to get decodable result: ${result}`,
  );

  const res: PoolState = {
    blockNumber: 0,
    nextOffer: 0n,
    offersIds: [],
    offers: [],
    offersDetail: [],
  };

  return generalDecoder(
    result,
    [
      'uint256',
      'uint256[]',
      '(uint256,uint256,int256,uint256)[]',
      '(address,uint256,uint256,uint256)[]',
    ],
    res,
    value => {
      res.nextOffer = value[0].toBigInt();
      res.offersIds = value[1].map((idx: BigNumber) => BigInt(idx.toString()));
      res.offers = value[2].map((row: BigNumber[]) => ({
        prev: BigInt(row[0].toString()),
        next: BigInt(row[1].toString()),
        tick: BigInt(row[2].toString()),
        gives: BigInt(row[3].toString()),
      }));
      res.offersDetail = value[3].map(
        (row: [string, BigNumber, BigNumber, BigNumber]) => ({
          maker: row[0],
          gasreq: BigInt(row[1].toString()),
          kilo_offer_gasbase: BigInt(row[2].toString()),
          gasprice: BigInt(row[3].toString()),
        }),
      );
      return res;
    },
  );
};

export class MangroveEventPool extends StatefulEventSubscriber<PoolState> {
  handlers: {
    [event: string]: (
      event: any,
      state: PoolState,
      log: Readonly<Log>,
    ) => PoolState | null;
  } = {};

  logDecoder: (log: Log) => any;

  addressesSubscribed: string[];

  readonly srcAddress: Address; //outbound_tkn
  readonly destAddress: Address; //inbound_tkn
  readonly tickSpacing: bigint;

  private _poolAddress?: Address;
  protected _stateRequestCallData?: MultiCallParams<
    bigint | DecodedStateMultiCallResult
  >[];

  public readonly readerIface = new Interface(MangroveReaderABI);
  public readonly mangroveIface = new Interface(MangroveABI);

  public initFailed = false;
  public initRetryAttemptCount = 0;

  private depth: number;
  private handler_state!: Record<
    number,
    { locked: boolean; offersTouched: Array<number> }
  >;

  constructor(
    public parentName: string,
    protected dexHelper: IDexHelper,
    protected readonly factoryAddress: Address,
    protected readonly readerAddress: Address,
    protected readonly mangroveAddress: Address,
    srcAddress: Address,
    destAddress: Address,
    tickSpacing: bigint,
    logger: Logger,
    //protected mangroveIface? = new Interface(
    //  '' /* TODO: Import and put here Mangrove ABI */,
    //), // TODO: add any additional params required for event subscriber
  ) {
    // TODO: Add pool name
    super(parentName, 'POOL_NAME', dexHelper, logger);
    this.srcAddress = srcAddress.toLowerCase();
    this.destAddress = destAddress.toLowerCase();
    this.tickSpacing = tickSpacing;

    // TODO: make logDecoder decode logs that
    this.logDecoder = (log: Log) => this.mangroveIface.parseLog(log);
    this.addressesSubscribed = [this.mangroveAddress];

    // Add handlers
    this.handlers['OfferWrite'] = this.handleOfferWrite.bind(this);
    this.handlers['OfferRetract'] = this.handleOfferRetract.bind(this);
    this.handlers['OfferSuccess'] = this.handleOfferSuccess.bind(this);
    this.handlers['OfferSuccessWithPostHookData'] =
      this.handleOfferSuccessWithPostHookData.bind(this);
    this.handlers['OfferFail'] = this.handleOfferFail.bind(this);
    this.handlers['OfferFailWithPostHookData'] =
      this.handledOfferFailWithPostHookData.bind(this);
    this.handlers['OrderStart'] = this.handleOrderStart.bind(this);
    this.handlers['OrderComplete'] = this.handleOrderComplete.bind(this);

    this.depth = 0;
    this.handler_state = {};
  }

  async initialize(
    blockNumber: number,
    options?: InitializeStateOptions<PoolState>,
  ) {
    await super.initialize(blockNumber, options);
  }

  //olKey
  public getPoolIdentifierData(): [Address, Address, bigint] {
    // Very important the order destAddress, srcAddress. This is the only function
    // where theseparams are inversed. All the other functions should call this one to get the pool.
    return [this.destAddress, this.srcAddress, this.tickSpacing];
  }

  public getOLKeyHash(olKey: [Address, Address, bigint]) {
    const abiCoder = new AbiCoder();
    const encodedData = abiCoder.encode(
      ['address', 'address', 'uint256'],
      [olKey[0], olKey[1], olKey[2]],
    );
    return keccak256(encodedData);
  }
  /**
   * The function is called every time any of the subscribed
   * addresses release log. The function accepts the current
   * state, updates the state according to the log, and returns
   * the updated state.
   * @param state - Current state of event subscriber
   * @param log - Log released by one of the subscribed addresses
   * @returns Updates state of the event subscriber after the log
   */
  protected processLog(
    state: DeepReadonly<PoolState>,
    log: Readonly<Log>,
  ): DeepReadonly<PoolState> | null {
    try {
      const event = this.logDecoder(log);
      const olKeyHash = this.getOLKeyHash(this.getPoolIdentifierData());

      if (event.name in this.handlers && event.args.olKeyHash === olKeyHash) {
        // console.log('event', event);
        // console.log('state before', state);
        const _state = _.cloneDeep(state) as PoolState;
        const res = this.handlers[event.name](event, _state, log);
        if (res) res.blockNumber = log.blockNumber;
        // console.log('state after', res);
        return res;
      } else {
        const _state = _.cloneDeep(state) as PoolState;
        _state.blockNumber = log.blockNumber;
        return _state;
      }
    } catch (e) {
      catchParseLogError(e, this.logger);
    }

    return null;
  }

  protected _getStateRequestCallData() {
    if (!this._stateRequestCallData) {
      const callData: MultiCallParams<bigint | DecodedStateMultiCallResult>[] =
        [
          {
            target: this.readerAddress,
            callData: this.readerIface.encodeFunctionData('offerList', [
              this.getPoolIdentifierData(),
              0,
              100,
            ]),
            decodeFunction: poolStateDecoder,
          },
        ];

      this._stateRequestCallData = callData;
    }
    return this._stateRequestCallData;
  }

  /**
   * The function generates state using on-chain calls. This
   * function is called to regenerate state if the event based
   * system fails to fetch events and the local state is no
   * more correct.
   * @param blockNumber - Blocknumber for which the state should
   * should be generated
   * @returns state of the event subscriber at blocknumber
   */
  async generateState(blockNumber: number): Promise<PoolState> {
    try {
      const callData = this._getStateRequestCallData();
      const [poolState] = await this.dexHelper.multiWrapper.tryAggregate<
        bigint | PoolState
      >(
        false,
        callData,
        blockNumber,
        this.dexHelper.multiWrapper.defaultBatchSize,
        false,
      );
      assert(poolState.success, 'Pool does not exist');

      // TO DO CHECK IF THERE ARE OFFERS assert(poolState.offers len > 1)
      const res = poolState.returnData as PoolState;
      res.blockNumber = blockNumber;
      return res;
    } catch (error) {
      this.logger.error('Error occurred during tryAggregate:', error);
      return {
        blockNumber: blockNumber,
        nextOffer: 0n,
        offersIds: [],
        offers: [],
        offersDetail: [],
      };
    }
  }

  offerWrite(
    state: PoolState,
    offerId: bigint,
    gives: bigint,
    tick: bigint,
    maker: string,
    gasreq: bigint,
    gasprice: bigint,
  ) {
    // Check if an offer with the same ID already exists
    const existingIndex = state.offersIds.findIndex(id => id === offerId);

    if (existingIndex !== -1) {
      // Remove the existing offer
      state.offersIds.splice(existingIndex, 1);
      state.offers.splice(existingIndex, 1);
      state.offersDetail.splice(existingIndex, 1);
    }
    // Create new offer and offerDetail
    const offer = { next: 0n, prev: 0n, tick: tick, gives: gives };
    const offerDetail = {
      maker: maker,
      gasreq: gasreq,
      kilo_offer_gasbase: 250n,
      gasprice: gasprice,
    };
    // Find the correct position to insert the new offer
    const insertIndex = state.offers.findIndex(o => o.tick > tick);

    if (insertIndex === -1) {
      // If no offer with higher tick found, append to the end
      state.offers.push(offer);
      state.offersDetail.push(offerDetail);
      state.offersIds.push(offerId);
    } else {
      // Insert at the correct position
      state.offers.splice(insertIndex, 0, offer);
      state.offersDetail.splice(insertIndex, 0, offerDetail);
      state.offersIds.splice(insertIndex, 0, offerId);
    }
    return state;
  }

  offerRetract(state: PoolState, offerId: number) {
    // Are Ids always in order?
    state.offersIds.splice(offerId, 1);
    state.offers.splice(offerId, 1);
    state.offersDetail.splice(offerId, 1);
    return state;
  }

  // Handlers

  handleOrderStart(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    this.depth++;
    this.handler_state[this.depth] = { locked: true, offersTouched: [] };
    return state;
  }

  handleOrderComplete(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    delete this.handler_state[this.depth];
    this.depth--;
    return state;
  }

  handleOfferWrite(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    const offerId = bigIntify(event.args.id);
    const maker = event.args.maker;
    const tick = bigIntify(event.args.tick);
    const gives = bigIntify(event.args.gives);
    const gasprice = bigIntify(event.args.gasprice);
    const gasreq = bigIntify(event.args.gasreq);

    state = this.offerWrite(
      state,
      offerId,
      gives,
      tick,
      maker,
      gasreq,
      gasprice,
    );
    if (this.handler_state[this.depth]?.locked)
      this.handler_state[this.depth].offersTouched.push(Number(offerId));
    return state;
  }

  handleOfferRetract(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    const offerId = event.id;
    state = this.offerRetract(state, offerId);
    return state;
  }

  handleOfferSuccess(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    const offerId = bigIntify(event.args.id);

    if (
      this.handler_state[this.depth].offersTouched.includes(Number(offerId))
    ) {
      this.handler_state[this.depth].offersTouched.splice(Number(offerId));
      //state = this.offerRetract(state, Number(offerId)); // TO DO ASK MAXENCE IF THIS SHOULD BE LIKE THIS
    } //else state = this.offerRetract(state, Number(offerId));

    return state;
  }

  handleOfferFail(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    const offerId = bigIntify(event.args.id);

    // Check if this.handler_state[this.depth] exists
    if (this.handler_state[this.depth]) {
      if (
        this.handler_state[this.depth].offersTouched.includes(Number(offerId))
      ) {
        this.handler_state[this.depth].offersTouched = this.handler_state[
          this.depth
        ].offersTouched.filter(id => id !== Number(offerId));
        state = this.offerRetract(state, Number(offerId));
      } else {
        state = this.offerRetract(state, Number(offerId));
      }
    }
    return state;
  }

  handleOfferSuccessWithPostHookData(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    const offerId = bigIntify(event.args.id);
    state = this.offerRetract(state, Number(offerId));
    return state;
  }

  handledOfferFailWithPostHookData(
    event: any,
    state: PoolState,
    log: Readonly<Log>,
  ): PoolState | null {
    const offerId = bigIntify(event.args.id);
    state = this.offerRetract(state, Number(offerId));
    return state;
  }
}
