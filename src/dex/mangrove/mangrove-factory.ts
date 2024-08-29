import { DeepReadonly } from 'ts-essentials';
import { Interface } from '@ethersproject/abi';
import FactoryABI from '../../abi/mangrove/MangroveFactory.abi.json';
import { StatefulEventSubscriber } from '../../stateful-event-subscriber';
import { FactoryState } from '../uniswap-v3/types';

import { IDexHelper } from '../../dex-helper/idex-helper';
import { Address, Log, Logger } from '../../types';
import { LogDescription } from 'ethers/lib/utils';

export type OnPoolCreatedCallback = ({
  olKeyHash,
  outbound_tkn,
  inbound_tkn,
  tickSpacing,
  value,
}: {
  olKeyHash: string;
  outbound_tkn: string;
  inbound_tkn: string;
  tickSpacing: bigint;
  value: boolean;
}) => Promise<void>;

export class MangroveFactory extends StatefulEventSubscriber<FactoryState> {
  handlers: {
    [event: string]: (event: any) => Promise<void>;
  } = {};

  logDecoder: (log: Log) => any;

  public readonly factoryIface = new Interface(FactoryABI);

  constructor(
    readonly dexHelper: IDexHelper,
    parentName: string,
    protected readonly factoryAddress: Address,
    logger: Logger,
    protected readonly onPoolCreated: OnPoolCreatedCallback,
  ) {
    super(parentName, `${parentName} Factory`, dexHelper, logger);

    this.addressesSubscribed = [factoryAddress];

    this.logDecoder = (log: Log) => this.factoryIface.parseLog(log);

    this.handlers['SetActive'] = this.handleNewPool.bind(this);
  }

  generateState(): FactoryState {
    return {};
  }

  protected async processLog(
    _: DeepReadonly<FactoryState>,
    log: Readonly<Log>,
  ): Promise<FactoryState> {
    const event = this.logDecoder(log);
    if (event.name in this.handlers) {
      await this.handlers[event.name](event);
    }

    return {};
  }

  async handleNewPool(event: LogDescription) {
    const olKeyHash = event.args.token0.toLowerCase();
    const outbound_tkn = event.args.outbound_tkn.toLowerCase();
    const inbound_tkn = event.args.inbound_tkn.toLowerCase();
    const tickSpacing = event.args.tickSpacing;
    const value = event.args.value;

    await this.onPoolCreated({
      olKeyHash,
      outbound_tkn,
      inbound_tkn,
      tickSpacing,
      value,
    });
  }
}
