import { Address, NumberAsString, Token } from '../../types';

export type PoolState = {
  tin: bigint; // toll in
  tout: bigint; // toll out
  rate: bigint;
  daiBalance: bigint; // `sellGem` ceiling
  gemBalance: bigint; // `buyGem` ceiling
};

export type LitePsmData = {
  psmAddress: Address;
  gemJoinAddress: Address;
  gemDecimals: number;
  toll: string;
  isApproved?: boolean;
};

export type PoolConfig = {
  gem: Token;
  gemJoinAddress: Address; // dai liquidity
  pocketAddress: Address; // gem liquidity
  psmAddress: Address;
  identifier: string; // bytes32 of pool identifier (Eg. bytes32("PSM-USDC-A"))
};

export type DexParams = {
  dai: Token;
  vatAddress: Address;
  pools: PoolConfig[];
};

export type LitePsmParams = [
  srcToken: Address,
  destToken: Address,
  fromAmount: NumberAsString,
  toAmount: NumberAsString,
  toll: NumberAsString,
  to18ConversionFactor: NumberAsString,
  exchange: Address,
  gemJoinAddress: Address,
  metadata: string,
  beneficiaryDirectionApproveFlag: NumberAsString,
];

export type LitePsmDirectPayload = [params: LitePsmParams, permit: string];
