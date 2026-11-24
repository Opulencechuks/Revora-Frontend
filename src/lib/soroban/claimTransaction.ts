/**
 * Soroban claim transaction builder, simulator, Freighter signer, and submit/poll helper.
 *
 * Strictly gated to Stellar Testnet (NETWORK_PASSPHRASE === Networks.TESTNET) so no
 * transaction can ever be signed or submitted on the public network.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import {
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  buildTransactionExplorerUrl,
} from '../../constants/stellar';
import { CONTRACT_METHODS, getRpcServer } from './revoraContract';

export type ClaimErrorCode =
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'USER_REJECTED'
  | 'TIMEOUT'
  | 'SIGNING_FAILED'
  | 'SUBMIT_FAILED'
  | 'TX_FAILED';

export class ClaimTransactionError extends Error {
  readonly code: ClaimErrorCode;
  readonly txHash?: string;

  constructor(code: ClaimErrorCode, message: string, txHash?: string) {
    super(message);
    this.name = 'ClaimTransactionError';
    this.code = code;
    this.txHash = txHash;
  }
}

export interface ClaimSimulationSuccess {
  ok: true;
  preparedTransaction: Transaction;
  minResourceFee: string;
  estimatedFeeStroops: string;
  estimatedFeeXlm: string;
}

export interface ClaimSimulationFailure {
  ok: false;
  error: string;
}

export type ClaimSimulationResult = ClaimSimulationSuccess | ClaimSimulationFailure;

export type ClaimPollStatus = 'SUBMITTED' | 'NOT_FOUND' | 'SUCCESS' | 'FAILED';

export interface ClaimPollUpdate {
  status: ClaimPollStatus;
  hash: string;
  attempt?: number;
  ledger?: number;
}

export interface ClaimSubmissionResult {
  status: 'SUCCESS';
  hash: string;
  ledger?: number;
  explorerUrl: string | null;
}

export interface SignClaimOptions {
  timeoutMs?: number;
}

export interface SubmitAndPollOptions {
  onStatus?: (update: ClaimPollUpdate) => void;
  pollIntervalMs?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}

const DEFAULT_TX_TIMEOUT_SECONDS = 30;
const DEFAULT_SIGN_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 15;
const DEFAULT_POLL_TIMEOUT_MS = 45_000;
const STROOPS_PER_XLM = 10_000_000;

/**
 * Formats a fee in stroops to a human-readable XLM string (e.g. "0.00125 XLM").
 */
export function formatStroopsToXlm(stroops: string | number | bigint): string {
  const value = typeof stroops === 'bigint' ? Number(stroops) : Number(stroops);
  if (!Number.isFinite(value) || value < 0) {
    return '0 XLM';
  }
  const xlm = value / STROOPS_PER_XLM;
  return `${xlm.toFixed(7).replace(/\.?0+$/, '')} XLM`;
}

/**
 * Returns true only when the wallet is connected to Stellar Testnet AND matches
 * the configured NETWORK_PASSPHRASE.
 */
export function isTestnetNetworkPassphrase(
  walletNetworkPassphrase: string | null | undefined,
): boolean {
  return (
    Boolean(walletNetworkPassphrase) &&
    walletNetworkPassphrase === NETWORK_PASSPHRASE &&
    walletNetworkPassphrase === Networks.TESTNET
  );
}

/**
 * Builds an unsigned Soroban claim transaction for the given beneficiary address
 * and distribution period ID.
 */
export async function buildClaimTransaction(
  address: string,
  periodId: number,
): Promise<Transaction> {
  if (!address || typeof address !== 'string') {
    throw new Error('A valid Stellar wallet address is required to build a claim transaction.');
  }
  if (!Number.isInteger(periodId) || periodId < 0) {
    throw new Error('A valid non-negative integer periodId is required.');
  }

  const server = getRpcServer();
  const account = await server.getAccount(address);
  const contract = new Contract(CONTRACT_ID);
  const operation = contract.call(
    CONTRACT_METHODS.CLAIM,
    nativeToScVal(periodId, { type: 'u32' }),
    new Address(address).toScVal(),
  );

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(DEFAULT_TX_TIMEOUT_SECONDS)
    .build();
}

/**
 * Simulates a claim transaction via Soroban RPC and returns either the prepared
 * transaction with fee estimates or a structured failure reason.
 */
export async function simulateClaimTransaction(
  transaction: Transaction,
): Promise<ClaimSimulationResult> {
  const server = getRpcServer();
  const simulation = await server.simulateTransaction(transaction);

  if (rpc.Api.isSimulationError(simulation)) {
    return {
      ok: false,
      error: simulation.error || 'Transaction simulation failed.',
    };
  }

  const minResourceFee =
    'minResourceFee' in simulation && simulation.minResourceFee
      ? String(simulation.minResourceFee)
      : '0';
  const totalFeeStroops = BigInt(BASE_FEE) + BigInt(minResourceFee);
  const preparedTransaction = rpc.assembleTransaction(transaction, simulation).build();

  return {
    ok: true,
    preparedTransaction,
    minResourceFee,
    estimatedFeeStroops: totalFeeStroops.toString(),
    estimatedFeeXlm: formatStroopsToXlm(totalFeeStroops),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ClaimTransactionError('TIMEOUT', message));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function extractFreighterErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '';
}

function isUserRejectionMessage(message: string): boolean {
  return /reject|declin|cancel|denied|user/i.test(message);
}

/**
 * Signs a prepared Soroban claim transaction using Freighter.
 * Refuses to sign if the wallet networkPassphrase does not match NETWORK_PASSPHRASE (testnet).
 */
export async function signClaimTransaction(
  preparedTransaction: Transaction,
  walletNetworkPassphrase: string | null | undefined,
  address: string,
  options: SignClaimOptions = {},
): Promise<{ signedTxXdr: string }> {
  if (!isTestnetNetworkPassphrase(walletNetworkPassphrase)) {
    throw new ClaimTransactionError(
      'NETWORK_MISMATCH',
      'Signing refused: switch Freighter to Stellar Testnet to claim.',
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
  const xdr = preparedTransaction.toXDR();

  const response = await withTimeout(
    signTransaction(xdr, {
      networkPassphrase: NETWORK_PASSPHRASE,
      address,
    }),
    timeoutMs,
    'Transaction signing timed out in Freighter. Please try again.',
  );

  if (response.error) {
    const errMsg = extractFreighterErrorMessage(response.error);
    if (isUserRejectionMessage(errMsg)) {
      throw new ClaimTransactionError(
        'USER_REJECTED',
        'Transaction signing was rejected in Freighter.',
      );
    }
    throw new ClaimTransactionError(
      'SIGNING_FAILED',
      errMsg || 'Freighter failed to sign the transaction.',
    );
  }

  if (!response.signedTxXdr) {
    throw new ClaimTransactionError(
      'SIGNING_FAILED',
      'Freighter did not return a signed transaction.',
    );
  }

  return { signedTxXdr: response.signedTxXdr };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submits a signed XDR transaction to Soroban RPC and polls getTransaction
 * until it resolves to SUCCESS, FAILED, or times out.
 */
export async function submitAndPollClaimTransaction(
  signedTxXdr: string,
  options: SubmitAndPollOptions = {},
): Promise<ClaimSubmissionResult> {
  const {
    onStatus,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = options;

  const server = getRpcServer();
  const signedTx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK_PASSPHRASE);
  const sendResponse = await server.sendTransaction(signedTx);

  if (sendResponse.status === 'ERROR') {
    throw new ClaimTransactionError(
      'SUBMIT_FAILED',
      'Transaction submission was rejected by the Stellar Testnet RPC server.',
      sendResponse.hash,
    );
  }

  const hash = sendResponse.hash;
  onStatus?.({ status: 'SUBMITTED', hash });

  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() > deadline) {
      throw new ClaimTransactionError(
        'TIMEOUT',
        'Transaction confirmation timed out while waiting for Stellar Testnet.',
        hash,
      );
    }

    const txResponse = await server.getTransaction(hash);

    if (txResponse.status === 'SUCCESS') {
      const ledger = 'ledger' in txResponse ? txResponse.ledger : undefined;
      onStatus?.({ status: 'SUCCESS', hash, attempt, ledger });
      return {
        status: 'SUCCESS',
        hash,
        ledger,
        explorerUrl: buildTransactionExplorerUrl(hash),
      };
    }

    if (txResponse.status === 'FAILED') {
      onStatus?.({ status: 'FAILED', hash, attempt });
      throw new ClaimTransactionError(
        'TX_FAILED',
        'Claim transaction failed on-chain.',
        hash,
      );
    }

    // NOT_FOUND — still pending confirmation
    onStatus?.({ status: 'NOT_FOUND', hash, attempt });

    if (attempt < maxAttempts && pollIntervalMs > 0) {
      await delay(pollIntervalMs);
    }
  }

  throw new ClaimTransactionError(
    'TIMEOUT',
    'Transaction confirmation timed out while waiting for Stellar Testnet.',
    hash,
  );
}
